import * as vscode from 'vscode';
import { DockerManager } from './dockerManager';
import { DockerKernelProvider } from './kernelProvider';

let dockerManager: DockerManager;
let kernelProvider: DockerKernelProvider;

export async function activate(context: vscode.ExtensionContext) {
    console.log('Jupyter Docker Runtime extension activating');
    try {
        console.log('Initializing DockerManager and DockerKernelProvider');

        // Initialize Docker manager
        dockerManager = new DockerManager(context);
        console.log('DockerManager created');
        
        // Initialize kernel provider
        kernelProvider = new DockerKernelProvider(dockerManager, context);
        console.log('DockerKernelProvider created');

    // Register kernel provider
    context.subscriptions.push(
        vscode.workspace.registerNotebookSerializer(
            'jupyter-notebook',
            kernelProvider,
            { transientOutputs: false }
        )
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('jupyter-docker.rebuildContainer', async () => {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Rebuilding Docker container...",
                cancellable: false
            }, async () => {
                await dockerManager.rebuildContainer();
                vscode.window.showInformationMessage('Container rebuilt successfully');
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jupyter-docker.stopContainer', async () => {
            await dockerManager.stopContainer();
            vscode.window.showInformationMessage('Container stopped');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jupyter-docker.selectKernel', async () => {
            const kernels = await dockerManager.listAvailableKernels();
            const selected = await vscode.window.showQuickPick(kernels, {
                placeHolder: 'Select a kernel'
            });
            if (selected) {
                vscode.window.showInformationMessage(`Selected kernel: ${selected}`);
            }
        })
    );

    // Auto-start container when notebook is opened
    context.subscriptions.push(
        vscode.workspace.onDidOpenNotebookDocument(async (notebook) => {
            if (notebook.notebookType === 'jupyter-notebook') {
                const config = vscode.workspace.getConfiguration('jupyterDocker');
                if (config.get('autoStart')) {
                    await ensureContainerRunning();
                }
            }
        })
    );

    // Try to start container on activation if notebooks are already open
    const notebooks = vscode.workspace.notebookDocuments;
    if (notebooks.length > 0) {
        await ensureContainerRunning();
    }
    } catch (err) {
        console.error('Extension activation error:', err);
        try {
            vscode.window.showErrorMessage(`Extension activation failed: ${err}`);
        } catch (e) {
            // ignore UI errors during early activation
        }
    }
}

async function ensureContainerRunning() {
    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Starting Jupyter Docker runtime...",
            cancellable: false
        }, async (progress) => {
            progress.report({ message: "Checking container status..." });
            
            const isRunning = await dockerManager.isContainerRunning();
            if (!isRunning) {
                progress.report({ message: "Building container image..." });
                await dockerManager.ensureContainer();
                
                progress.report({ message: "Installing Jupyter kernel..." });
                await dockerManager.setupKernel();
                
                vscode.window.showInformationMessage('Jupyter Docker runtime ready!');
            }
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to start container: ${error}`);
    }
}

export function deactivate() {
    if (dockerManager) {
        dockerManager.dispose();
    }
}