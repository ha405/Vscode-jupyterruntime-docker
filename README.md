# Jupyter Docker Runtime Extension

A VS Code extension that automatically runs Jupyter notebooks in Docker containers.

## Quick Start

### 1. Build the Extension

```powershell
npm install
npm run compile
```

### 2. Launch in Development Mode

Press `F5` in VS Code to launch the extension in a new window, or manually run:

```powershell
code --extensionDevelopmentPath=. .
```

### 3. Test with the Notebook

- Open `test-notebook.ipynb` in the extension host window
- The extension should auto-start and build the Docker container
- Try running cells — they should execute in the Docker container

### 4. Run Commands

From the Command Palette (`Ctrl+Shift+P`):

- **Jupyter Docker: Rebuild Container** — Rebuild the Docker image from scratch
- **Jupyter Docker: Stop Container** — Stop the running container
- **Jupyter Docker: Select Kernel** — Choose an available kernel

## Configuration

Settings in `.vscode/settings.json` or VS Code preferences:

- `jupyterDocker.autoStart` (boolean, default: true) — Auto-start container when opening notebooks
- `jupyterDocker.dockerfilePath` (string, default: "Dockerfile") — Path to Dockerfile relative to workspace root
- `jupyterDocker.containerName` (string, default: "jupyter-runtime") — Name for the Docker container
- `jupyterDocker.pythonPath` (string, default: "/usr/local/bin/python3") — Python path inside container

## Extension Structure

```
src/
  extension.ts       — Extension entry point and command handlers
  dockerManager.ts   — Docker container/image management
  kernelProvider.ts  — Notebook controller and code execution
  package.json       — (in root now) Extension manifest
  tsconfig.json      — TypeScript configuration
```

## Troubleshooting

### Extension doesn't activate

1. Check that a notebook is open (extension activates on `onNotebook:jupyter-notebook`)
2. Open the Developer Tools (`Help → Toggle Developer Tools`) and check the console for errors
3. Verify the `main` entry in `package.json` points to `./src/out/extension.js`

### Docker container won't start

1. Ensure Docker Desktop is running
2. Check Docker socket accessibility on your system
3. Try manually running `docker ps` in a terminal to verify Docker is working

### Cells won't execute

1. Verify the container is running: check Docker Desktop or run `docker ps`
2. Open the Output panel and check the "Jupyter Docker Runtime" channel for logs
3. Ensure the Dockerfile has all necessary Python packages installed

## Development

- **Compile** (watching): `npm run watch`
- **Lint**: `npm run lint`
- **Package extension**: `npm run package` (requires @vscode/vsce)

## Known Limitations

- Requires Docker Desktop to be running
- Kernel helper script uses base64-encoded code for execution
- No support for kernel interruption yet
- Only Python 3 is supported in the default Dockerfile
