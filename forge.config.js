module.exports = {
  packagerConfig: {
    asar: true,
    name: 'TerminalDeck',
    executableName: 'TerminalDeck',
    extraResource: ['scripts/shell-integration.ps1'],
    ignore: [
      /^\/\.github(?:\/|$)/u,
      /\.log$/u,
      /^\/(?:forge\.config\.js|package-lock\.json|\.gitignore|\.gitattributes)$/u,
      /^\/\.claude(?:\/|$)/u,
      /^\/doc(?:\/|$)/u,
      /^\/test(?:\/|$)/u,
      /^\/scripts\/electron-.*\.js$/u,
      /^\/electron-.*\.log$/u,
      /^\/out(?:\/|$)/u,
      /^\/release(?:\/|$)/u
    ],
    win32metadata: {
      CompanyName: 'Terminal Deck contributors',
      FileDescription: 'Terminal Deck',
      InternalName: 'TerminalDeck',
      ProductName: 'Terminal Deck'
    }
  },
  // node-pty 1.1.0 ships Node-API prebuilds for Windows x64. Rebuilding those
  // portable binaries is unnecessary and would require extra VS Spectre libs.
  rebuildConfig: {
    ignoreModules: ['node-pty']
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        // Keep the legacy Squirrel package ID so existing installations can
        // upgrade in place even though the visible product name has changed.
        name: 'multi_session_manager',
        setupExe: 'TerminalDeck-Setup.exe'
      }
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32']
    }
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {}
    }
  ]
};
