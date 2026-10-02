const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, utilityProcess } = require('electron');
const { WorkspaceSaveService } = require('../src/workspace-save-service');
const {
  createWorkspace,
  initializeWorkspaceStore,
  loadWorkspace
} = require('../src/workspace-store');

const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-save-profile-'));
for (const [name, directory] of [
  ['userData', 'user-data'],
  ['sessionData', 'session-data'],
  ['cache', 'cache'],
  ['crashDumps', 'crash-dumps']
]) {
  const target = path.join(profileRoot, directory);
  fs.mkdirSync(target, { recursive: true });
  app.setPath(name, target);
}
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-save-smoke-'));
  let blockingService;
  let saveService;
  try {
    blockingService = new WorkspaceSaveService(utilityProcess.fork, {
      workerPath: path.join(__dirname, 'blocking-save-worker-fixture.js')
    });
    let heartbeat = false;
    const blocked = blockingService.save({});
    setTimeout(() => { heartbeat = true; }, 50);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(heartbeat, true, 'utility save must not block the Electron main loop');
    assert.deepEqual(await blocked, { completed: true });
    assert.notEqual(blockingService.pid, process.pid);
    await blockingService.terminate();
    blockingService = null;

    initializeWorkspaceStore(directory);
    const workspace = createWorkspace(directory, { name: 'save smoke' });
    saveService = new WorkspaceSaveService(utilityProcess.fork);
    const operationId = 'electron-save-smoke';
    await saveService.save({
      baseDirectory: directory,
      workspaceId: workspace.id,
      state: {
        favorites: [{ id: 'saved', name: 'saved', command: 'echo saved' }],
        tabs: [{ key: 'saved-tab', name: 'saved tab', cwd: directory }]
      },
      options: { saveFavorites: true, operationId }
    });
    await saveService.acknowledge({ baseDirectory: directory, operationId });
    const loaded = loadWorkspace(directory, workspace.id);
    assert.equal(loaded.state.tabs[0].key, 'saved-tab');
    assert.equal(loaded.state.favorites[0].id, 'saved');
    assert.equal(
      fs.existsSync(path.join(
        directory,
        'save-transactions',
        `${operationId}.applied`
      )),
      false
    );
    console.log('Utility-process save responsiveness and transaction smoke passed.');
  } finally {
    await blockingService?.terminate();
    await saveService?.terminate();
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(profileRoot, { recursive: true, force: true });
    app.quit();
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
