import * as vscode from 'vscode';
import Docker, { ContainerInfo } from 'dockerode';
import * as path from 'path';
import * as fs from 'fs';
import * as tar from 'tar-stream';

export class DockerManager {
    private docker: Docker;
    private container: Docker.Container | undefined;
    private config: vscode.WorkspaceConfiguration;
    private workspaceRoot: string;

    constructor(private context: vscode.ExtensionContext) {
        this.docker = new Docker();
        this.config = vscode.workspace.getConfiguration('jupyterDocker');
        
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder open');
        }
        this.workspaceRoot = workspaceFolder.uri.fsPath;
    }

    async isContainerRunning(): Promise<boolean> {
        try {
            const containerName = this.getContainerName();
            const containers = await this.docker.listContainers();
            return containers.some((c: ContainerInfo) => c.Names.includes(`/${containerName}`));
        } catch (error) {
            return false;
        }
    }

    async ensureContainer(): Promise<void> {
        const containerName = this.getContainerName();
        
        // Check if container already exists
        try {
            this.container = this.docker.getContainer(containerName);
            const info = await this.container.inspect();
            
            if (info.State.Running) {
                console.log('Container already running');
                return;
            }
            
            // Start existing container
            await this.container.start();
            console.log('Started existing container');
            return;
        } catch (error) {
            // Container doesn't exist, continue to create it
        }

        // Build image if needed
        await this.buildImage();

        // Create and start container
        await this.createContainer();
    }

    private async buildImage(): Promise<void> {
        const imageName = this.getImageName();
        const dockerfilePath = path.join(
            this.workspaceRoot,
            this.config.get('dockerfilePath', 'Dockerfile')
        );

        // Check if Dockerfile exists
        if (!fs.existsSync(dockerfilePath)) {
            // Create a default Dockerfile
            await this.createDefaultDockerfile(dockerfilePath);
        }

        // Check if image already exists
        try {
            await this.docker.getImage(imageName).inspect();
            console.log('Image already exists');
            return;
        } catch (error) {
            // Image doesn't exist, build it
        }

        // Build the image
        console.log('Building Docker image...');
        const pack = tar.pack();
        
        // Add Dockerfile to tar stream
        const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');
        pack.entry({ name: 'Dockerfile' }, dockerfileContent, (err: Error | null | undefined) => {
            if (err) console.error('Error adding Dockerfile to tar:', err);
            pack.finalize();
        });

        try {
            const stream = await this.docker.buildImage(pack, { t: imageName });
            
            await new Promise<void>((resolve, reject) => {
                stream.on('data', (chunk: any) => {
                    const str = chunk.toString();
                    if (str.includes('error')) {
                        console.error(str);
                    } else {
                        console.log(str);
                    }
                });
                
                stream.on('end', () => {
                    resolve();
                });
                
                stream.on('error', (err: Error) => {
                    reject(err);
                });
            });

            console.log('Image built successfully');
        } catch (error) {
            console.error('Failed to build image:', error);
            throw error;
        }
    }

    private async createContainer(): Promise<void> {
        const containerName = this.getContainerName();
        const imageName = this.getImageName();

        this.container = await this.docker.createContainer({
            Image: imageName,
            name: containerName,
            Tty: true,
            OpenStdin: true,
            WorkingDir: '/workspace',
            HostConfig: {
                Binds: [`${this.workspaceRoot}:/workspace`],
                AutoRemove: false
            },
            Cmd: ['tail', '-f', '/dev/null'] // Keep container running
        });

        await this.container.start();
        console.log('Container created and started');
    }

    async setupKernel(): Promise<void> {
        if (!this.container) {
            throw new Error('Container not initialized');
        }

        // Install ipykernel if not present
        await this.execInContainer([
            'pip', 'install', '--quiet', 'ipykernel', 'jupyter'
        ]);

        // Install the kernel
        await this.execInContainer([
            'python3', '-m', 'ipykernel', 'install',
            '--user',
            '--name', 'docker-python',
            '--display-name', 'Python (Docker)'
        ]);

        // Copy kernel helper script
        await this.copyKernelHelper();

        console.log('Kernel setup complete');
    }

    private async copyKernelHelper(): Promise<void> {
        if (!this.container) {
            throw new Error('Container not initialized');
        }

        const helperScript = `
import sys
import json
import base64
import traceback
from io import StringIO

def execute_code(code):
    """Execute code and capture output"""
    old_stdout = sys.stdout
    old_stderr = sys.stderr
    redirected_output = StringIO()
    redirected_error = StringIO()
    sys.stdout = redirected_output
    sys.stderr = redirected_error
    
    result = {
        'status': 'ok',
        'output': '',
        'error': ''
    }
    
    try:
        exec(code, globals())
        result['output'] = redirected_output.getvalue()
    except Exception as e:
        result['status'] = 'error'
        result['error'] = traceback.format_exc()
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr
    
    return result

if __name__ == '__main__':
    if len(sys.argv) > 1:
        encoded_code = sys.argv[1]
        code = base64.b64decode(encoded_code).decode('utf-8')
        result = execute_code(code)
        print(json.dumps(result))
    else:
        print(json.dumps({'status': 'error', 'error': 'No code provided'}))
`;

        // Create tar stream with the helper script
        const pack = tar.pack();
        pack.entry({ name: 'kernel_helper.py' }, helperScript);
        pack.finalize();

        // Upload to container
        await this.container.putArchive(pack, { path: '/tmp' });
    }

    async execInContainer(cmd: string[]): Promise<string> {
        if (!this.container) {
            throw new Error('Container not initialized');
        }

        const exec = await this.container.exec({
            Cmd: cmd,
            AttachStdout: true,
            AttachStderr: true
        });

        const stream = await exec.start({ hijack: true, stdin: false });
        
        return new Promise((resolve, reject) => {
            let output = '';
            
            stream.on('data', (chunk: Buffer) => {
                output += chunk.toString('utf-8');
            });

            stream.on('end', () => {
                resolve(output);
            });

            stream.on('error', reject);
        });
    }

    async executeCode(code: string): Promise<{ status: string; output: string; error: string }> {
        const encodedCode = Buffer.from(code).toString('base64');
        const pythonPath = this.config.get('pythonPath', '/usr/local/bin/python3');
        
        const output = await this.execInContainer([
            pythonPath,
            '/tmp/kernel_helper.py',
            encodedCode
        ]);

        // Parse JSON output
        try {
            // Remove Docker exec header bytes (first 8 bytes)
            const cleanOutput = output.slice(8);
            return JSON.parse(cleanOutput);
        } catch (error) {
            return {
                status: 'error',
                output: '',
                error: `Failed to parse execution result: ${output}`
            };
        }
    }

    async listAvailableKernels(): Promise<string[]> {
        if (!this.container) {
            return [];
        }

        try {
            const output = await this.execInContainer([
                'jupyter', 'kernelspec', 'list', '--json'
            ]);
            
            const cleanOutput = output.slice(8); // Remove Docker header
            const data = JSON.parse(cleanOutput);
            return Object.keys(data.kernelspecs || {});
        } catch (error) {
            return ['docker-python'];
        }
    }

    async rebuildContainer(): Promise<void> {
        await this.stopContainer();
        
        // Remove existing image
        const imageName = this.getImageName();
        try {
            const image = this.docker.getImage(imageName);
            await image.remove();
        } catch (error) {
            // Image might not exist
        }

        await this.ensureContainer();
        await this.setupKernel();
    }

    async stopContainer(): Promise<void> {
        if (this.container) {
            try {
                await this.container.stop();
                await this.container.remove();
                this.container = undefined;
            } catch (error) {
                console.error('Error stopping container:', error);
            }
        }
    }

    private async createDefaultDockerfile(dockerfilePath: string): Promise<void> {
        const defaultDockerfile = `
FROM python:3.11-slim

WORKDIR /workspace

# Install system dependencies
RUN apt-get update && apt-get install -y \\
    build-essential \\
    curl \\
    git \\
    && rm -rf /var/lib/apt/lists/*

# Install Python packages
RUN pip install --no-cache-dir \\
    jupyter \\
    ipykernel \\
    numpy \\
    pandas \\
    matplotlib \\
    scikit-learn

# Create kernel
RUN python3 -m ipykernel install --user --name docker-python

CMD ["tail", "-f", "/dev/null"]
`.trim();

        fs.writeFileSync(dockerfilePath, defaultDockerfile);
        console.log('Created default Dockerfile');
    }

    private getContainerName(): string {
        return this.config.get('containerName', 'jupyter-runtime');
    }

    private getImageName(): string {
        const workspaceName = path.basename(this.workspaceRoot);
        return `jupyter-docker-${workspaceName.toLowerCase()}`;
    }

    dispose(): void {
        // Optionally stop container on extension deactivation
        // this.stopContainer();
    }
}