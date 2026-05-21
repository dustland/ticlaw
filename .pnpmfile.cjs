module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === 'better-sqlite3' || pkg.name === 'esbuild') {
        pkg.pnpm = pkg.pnpm || {};
        pkg.pnpm.allowScripts = true;
      }
      return pkg;
    }
  }
}
