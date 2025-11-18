import * as vscode from 'vscode';
import { DockerManager } from './dockerManager';

export class DockerKernelProvider implements vscode.NotebookSerializer {
    private controller: vscode.NotebookController;
    
    constructor(
        private dockerManager: DockerManager,
        private context: vscode.ExtensionContext
    ) {
        // Create notebook controller
        this.controller = vscode.notebooks.createNotebookController(
            'jupyter-docker-kernel',
            'jupyter-notebook',
            'Python (Docker)',
            this.executeHandler.bind(this)
        );

        this.controller.supportedLanguages = ['python'];
        this.controller.supportsExecutionOrder = true;
        this.controller.description = 'Run Python code in Docker container';

        context.subscriptions.push(this.controller);
    }

    async deserializeNotebook(
        content: Uint8Array,
        _token: vscode.CancellationToken
    ): Promise<vscode.NotebookData> {
        try {
            const contents = new TextDecoder().decode(content);
            const notebook = JSON.parse(contents);

            const cells = (notebook.cells || []).map((cell: any) => {
                const cellKind = cell.cell_type === 'code'
                    ? vscode.NotebookCellKind.Code
                    : vscode.NotebookCellKind.Markup;

                const cellData = new vscode.NotebookCellData(
                    cellKind,
                    Array.isArray(cell.source) ? cell.source.join('') : cell.source,
                    cell.cell_type === 'code' ? 'python' : 'markdown'
                );

                cellData.outputs = (cell.outputs || []).map((output: any) => 
                    this.deserializeOutput(output)
                );

                cellData.executionSummary = cell.execution_count
                    ? { executionOrder: cell.execution_count }
                    : undefined;

                return cellData;
            });

            return new vscode.NotebookData(cells);
        } catch (error) {
            console.error('Error deserializing notebook:', error);
            return new vscode.NotebookData([]);
        }
    }

    async serializeNotebook(
        data: vscode.NotebookData,
        _token: vscode.CancellationToken
    ): Promise<Uint8Array> {
        const notebook = {
            cells: data.cells.map((cell) => ({
                cell_type: cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown',
                source: cell.value.split('\n').map(line => line + '\n'),
                metadata: {},
                outputs: cell.outputs?.map(output => this.serializeOutput(output)) || [],
                execution_count: cell.executionSummary?.executionOrder || null
            })),
            metadata: {
                kernelspec: {
                    display_name: 'Python (Docker)',
                    language: 'python',
                    name: 'docker-python'
                },
                language_info: {
                    name: 'python',
                    version: '3.11'
                }
            },
            nbformat: 4,
            nbformat_minor: 4
        };

        return new TextEncoder().encode(JSON.stringify(notebook, null, 2));
    }

    private async executeHandler(
        cells: vscode.NotebookCell[],
        _notebook: vscode.NotebookDocument,
        _controller: vscode.NotebookController
    ): Promise<void> {
        for (const cell of cells) {
            await this.executeCell(cell);
        }
    }

    private async executeCell(cell: vscode.NotebookCell): Promise<void> {
        const execution = this.controller.createNotebookCellExecution(cell);
        execution.start(Date.now());

        try {
            const code = cell.document.getText();
            
            if (!code.trim()) {
                execution.end(true, Date.now());
                return;
            }

            // Ensure container is running
            const isRunning = await this.dockerManager.isContainerRunning();
            if (!isRunning) {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Starting Docker container...",
                    cancellable: false
                }, async () => {
                    await this.dockerManager.ensureContainer();
                    await this.dockerManager.setupKernel();
                });
            }

            // Execute code in container
            const result = await this.dockerManager.executeCode(code);

            // Clear existing outputs
            execution.clearOutput(cell);

            // Handle output
            if (result.status === 'ok') {
                if (result.output) {
                    const output = new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.text(result.output, 'text/plain')
                    ]);
                    execution.appendOutput(output);
                }
                execution.end(true, Date.now());
            } else {
                // Error occurred
                const errorOutput = new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.error({
                        name: 'ExecutionError',
                        message: result.error
                    })
                ]);
                execution.appendOutput(errorOutput);
                execution.end(false, Date.now());
            }

        } catch (error) {
            const errorOutput = new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.error({
                    name: 'ExecutionError',
                    message: String(error)
                })
            ]);
            execution.appendOutput(errorOutput);
            execution.end(false, Date.now());
        }
    }

    private deserializeOutput(output: any): vscode.NotebookCellOutput {
        const items: vscode.NotebookCellOutputItem[] = [];

        if (output.output_type === 'stream') {
            const text = Array.isArray(output.text) 
                ? output.text.join('') 
                : output.text;
            items.push(vscode.NotebookCellOutputItem.text(text, 'text/plain'));
        } else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
            const data = output.data || {};
            
            if (data['text/plain']) {
                const text = Array.isArray(data['text/plain'])
                    ? data['text/plain'].join('')
                    : data['text/plain'];
                items.push(vscode.NotebookCellOutputItem.text(text, 'text/plain'));
            }
            
            if (data['text/html']) {
                const html = Array.isArray(data['text/html'])
                    ? data['text/html'].join('')
                    : data['text/html'];
                items.push(vscode.NotebookCellOutputItem.text(html, 'text/html'));
            }
            
            if (data['image/png']) {
                const buffer = Buffer.from(data['image/png'], 'base64');
                items.push(vscode.NotebookCellOutputItem.text(
                    buffer.toString('base64'),
                    'image/png'
                ));
            }
        } else if (output.output_type === 'error') {
            items.push(vscode.NotebookCellOutputItem.error({
                name: output.ename || 'Error',
                message: output.evalue || 'Unknown error',
                stack: (output.traceback || []).join('\n')
            }));
        }

        return new vscode.NotebookCellOutput(items);
    }

    private serializeOutput(output: vscode.NotebookCellOutput): any {
        const items = output.items;
        
        if (items.length === 0) {
            return { output_type: 'stream', name: 'stdout', text: [] };
        }

        const firstItem = items[0];
        
        if (firstItem.mime === 'application/vnd.code.notebook.error') {
            const error = JSON.parse(new TextDecoder().decode(firstItem.data));
            return {
                output_type: 'error',
                ename: error.name || 'Error',
                evalue: error.message || '',
                traceback: error.stack ? error.stack.split('\n') : []
            };
        }

        if (firstItem.mime === 'text/plain') {
            return {
                output_type: 'stream',
                name: 'stdout',
                text: new TextDecoder().decode(firstItem.data).split('\n')
            };
        }

        // Default to display_data for other types
        const data: any = {};
        for (const item of items) {
            data[item.mime] = new TextDecoder().decode(item.data);
        }

        return {
            output_type: 'display_data',
            data: data
        };
    }
}