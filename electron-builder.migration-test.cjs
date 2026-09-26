const path = require('node:path');
const fs = require('node:fs');
const base = require('./package.json');

const electronDist = process.env.SILLYCLIENT_TEST_ELECTRON_DIST;
const nodeDir = process.env.SILLYCLIENT_TEST_NODE_DIR || path.join(__dirname, 'runtime', 'node');
if (!electronDist || !path.isAbsolute(electronDist) || !fs.existsSync(path.join(electronDist, 'electron.exe'))) {
  throw new Error('Set SILLYCLIENT_TEST_ELECTRON_DIST to the prepared Electron 33.4.11 dist directory.');
}
if (!path.isAbsolute(nodeDir) || !fs.existsSync(path.join(nodeDir, 'node.exe'))) {
  throw new Error('Set SILLYCLIENT_TEST_NODE_DIR to the complete bundled Node.js 22.16.0 runtime.');
}

module.exports = {
  ...base.build,
  appId: base.build.appId,
  productName: base.build.productName,
  executableName: 'SillyClient',
  electronVersion: '33.4.11',
  electronDist,
  npmRebuild: false,
  directories: {
    output: path.resolve(__dirname, '../../Local/cache/windows-data-migration/inplace-package-output'),
  },
  files: [
    'package.json',
    'build/icon.png',
    'build/icon.ico',
    'resources/import-debug/**/*',
    { from: fs.realpathSync(path.join(__dirname, 'dist')), to: 'dist', filter: ['**/*'] },
    { from: fs.realpathSync(path.join(__dirname, 'frontend-dist')), to: 'frontend-dist', filter: ['**/*'] },
    { from: fs.realpathSync(path.join(__dirname, 'node_modules', 'adm-zip')), to: 'node_modules/adm-zip', filter: ['**/*'] },
    { from: fs.realpathSync(path.join(__dirname, 'node_modules', 'fast-json-stable-stringify')), to: 'node_modules/fast-json-stable-stringify', filter: ['**/*'] },
    { from: fs.realpathSync(path.join(__dirname, 'node_modules', 'yaml')), to: 'node_modules/yaml', filter: ['**/*'] },
  ],
  extraMetadata: {
    name: base.name,
    productName: base.build.productName,
    version: `${base.version}-migration.10`,
  },

  nsis: {
    ...base.build.nsis,
    guid: 'e0b7f7d8-412f-5b5c-988d-cbdb03e1cf56',
    allowElevation: false,
    runAfterFinish: false,
    deleteAppDataOnUninstall: false,
    shortcutName: 'SillyClient',
    createDesktopShortcut: 'always',
    artifactName: 'SillyClient-Local-Test-${version}-Setup.${ext}',
  },
  extraResources: [
    ...base.build.extraResources.map(resource =>
      resource.to === 'runtime/node' ? { ...resource, from: nodeDir } : resource),
    { from: 'scripts/data-migration.mjs', to: 'migration-tool/scripts/data-migration.mjs' },
    { from: 'src/runtime/data-migration.ts', to: 'migration-tool/src/runtime/data-migration.ts' },
    { from: fs.realpathSync(path.join(__dirname, 'node_modules', 'yaml')), to: 'migration-tool/node_modules/yaml' },
    { from: 'resources/migration-test/tool-package.json', to: 'migration-tool/package.json' },
  ],
  extraFiles: [
    { from: 'resources/migration-test/Run-Migration.cmd', to: 'Run-Migration.cmd' },
    { from: 'docs/DATA-MIGRATION.md', to: 'DATA-MIGRATION.md' },
  ],
};
