# supi

[![Status](https://travis-ci.org/pnpm/supi.svg?branch=master)](https://travis-ci.org/pnpm/supi "See test builds")
[![Windows build status](https://ci.appveyor.com/api/projects/status/18j52s5bdd71pjy5/branch/master?svg=true)](https://ci.appveyor.com/project/zkochan/supi/branch/master)

> Fast, disk space efficient installation engine. Used by [pnpm](https://github.com/pnpm/pnpm)

## Install

Install it via npm.

```
npm install supi
```

## API

### `pnpm.installPkgs(pkgsToInstall, [options])`

Install packages.

**Arguments:**

* `pkgsToInstall` - *Object | String[]* - either an object that maps package names to version ranges or inputs usually passed to `npm install` (e.g., `foo@1.0.0`, `foo`).
* `options.saveProd` - *Boolean* - package will appear in `dependencies`.
* `options.saveDev` - *Boolean* - package will appear in `devDependencies`.
* `options.saveOptional` - *Boolean* - package will appear in `optionalDependencies`.
* `options.saveExact` - *Boolean* - saved dependencies will be configured with an exact version rather than using npm's default semver range operator.
* `options.global` - *Boolean* - the packages will be installed globally rather than locally.
* `options.prefix` - *String* - the directory in which the installation will be performed. By default the `process.cwd()` value is used.
* `options.quiet` - *Boolean* - `false` by default. No output to the console.
* `options.metaCache` - *Map* - a cache for package meta info.
* `options.networkConcurrency` - *Number* - `16` by default. Max amount of network requests to perform concurrently.
* `options.offline` - *Boolean* - `false` by default. Install packages using only the local registry mirror, w/o doing any network requests.
* `options.reporter` - *Function* - A function that listens for logs.
* `options.packageManager` - *Object* - The `package.json` of the package manager.

**Returns:** a Promise

**Example:**

```js
const pnpm = require('pnpm')

pnpm.install({
  'is-positive': '1.0.0',
  'hello-world': '^2.3.1'
}, { save: true, quiet: true })
```

### `pnpm.install([options])`

Install all modules listed as dependencies in `package.json`.

**Arguments:** (same as in named install and additionally)

* `options.production` - *Boolean* - `false` by default or `true` when the `NODE_ENV` environment variable is set to `production`. Modules listed in `devDependencies` will not be installed.

### `pnpm.uninstall(pkgsToUninstall, [options])`

Uninstalls a package, completely removing everything pnpm installed on its behalf.

**Arguments:**

* `pkgsToUninstall` - *String[]* - the package names to be uninstalled.
* `options.saveProd` - *Boolean* - the package will be removed from `dependencies`.
* `options.saveDev` - *Boolean* - the package will be removed from `devDependencies`.
* `options.saveOptional` - *Boolean* - the package will be removed from `optionalDependencies`.
* `options.global` - *Boolean* - the packages will be uninstalled globally.
* `options.reporter` - *Function* - A function that listens for logs.

### `pnpm.link(linkFrom, lintTo, [options])`

Create a symbolic link from the linked package to the target package's `node_modules` (and its `node_modules/.bin`).

**Arguments:**

* `linkFrom` - *String* - path to the package that should be linked.
* `lintTo` - *String* - path to the dependent package.
* `options.reporter` - *Function* - A function that listens for logs.

### `pnpm.linkToGlobal(linkFrom, options)`

Create a symbolic link from the specified package to the global `node_modules`.

**Arguments:**

* `linkFrom` - *String* - path to the package that should be linked.
* `globalPrefix` - *String* - path to the global directory.
* `options.reporter` - *Function* - A function that listens for logs.

### `pnpm.linkFromGlobal(pkgName, linkTo, options)`

Create a symbolic link from the global `pkgName` to the `linkTo/node_modules` folder.

**Arguments:**

* `pkgName` - *String* - package to link.
* `linkTo` - *String* - package to link to.
* `globalPrefix` - *String* - path to the global directory.
* `options.reporter` - *Function* - A function that listens for logs.

### `pnpm.prune([options])`

Remove extraneous packages. Extraneous packages are packages that are not listed on the parent package's dependencies list.

**Arguments:**

* `options.production` - *Boolean* - by default `false`. If this property is `true`, prune will remove the packages specified in `devDependencies`.
* `options.prefix` - *String* - by default `process.cwd()`.
* `options.reporter` - *Function* - A function that listens for logs.

### `pnpm.storeStatus([options])`

Return the list of modified dependencies.

**Arguments:**

* `options.reporter` - *Function* - A function that listens for logs.

**Returns:** `Promise<string[]>` - the paths to the modified packages of the current project. The paths contain the location of packages in the store,
not in the projects `node_modules` folder.

## License

[MIT](LICENSE)
