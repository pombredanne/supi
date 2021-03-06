import path = require('path')
import RegClient = require('npm-registry-client')
import logger from 'pnpm-logger'
import logStatus from '../logging/logInstallStatus'
import pLimit = require('p-limit')
import npa = require('npm-package-arg')
import pFilter = require('p-filter')
import R = require('ramda')
import safeIsInnerLink from '../safeIsInnerLink'
import {fromDir as safeReadPkgFromDir} from '../fs/safeReadPkg'
import {PnpmOptions, StrictPnpmOptions, Dependencies} from '../types'
import getContext, {PnpmContext} from './getContext'
import installMultiple, {InstalledPackage} from '../install/installMultiple'
import externalLink from './link'
import linkPackages from '../link'
import save from '../save'
import getSaveType from '../getSaveType'
import {sync as runScriptSync} from '../runScript'
import postInstall from '../install/postInstall'
import extendOptions from './extendOptions'
import lock from './lock'
import {
  write as saveShrinkwrap,
  Shrinkwrap,
  ResolvedDependencies,
} from 'pnpm-shrinkwrap'
import {pkgIdToRef} from '../fs/shrinkwrap'
import {
  save as saveModules,
  LAYOUT_VERSION,
} from '../fs/modulesController'
import mkdirp = require('mkdirp-promise')
import createMemoize, {MemoizedFunc} from '../memoize'
import {Package} from '../types'
import {DependencyTreeNode} from '../link/resolvePeers'
import depsToSpecs, {similarDepsToSpecs} from '../depsToSpecs'
import streamParser from '../logging/streamParser'
import {
  createGot,
  Store,
  PackageContentInfo,
  PackageSpec,
  DirectoryResolution,
  Resolution,
} from 'package-store'

export type InstalledPackages = {
  [name: string]: InstalledPackage
}

export type TreeNode = {
  nodeId: string,
  children: string[], // Node IDs of children
  pkg: InstalledPackage,
  depth: number,
  installable: boolean,
}

export type TreeNodeMap = {
  [nodeId: string]: TreeNode,
}

export type InstallContext = {
  installs: InstalledPackages,
  localPackages: {
    optional: boolean,
    dev: boolean,
    resolution: DirectoryResolution,
    id: string,
    version: string,
    name: string,
    specRaw: string,
  }[],
  childrenIdsByParentId: {[parentId: string]: string[]},
  nodesToBuild: {
    nodeId: string,
    pkg: InstalledPackage,
    depth: number,
    installable: boolean,
  }[],
  shrinkwrap: Shrinkwrap,
  privateShrinkwrap: Shrinkwrap,
  fetchingLocker: {
    [pkgId: string]: {
      fetchingFiles: Promise<PackageContentInfo>,
      fetchingPkg: Promise<Package>,
      calculatingIntegrity: Promise<void>,
    },
  },
  // the IDs of packages that are not installable
  skipped: Set<string>,
  tree: {[nodeId: string]: TreeNode},
  storeIndex: Store,
}

export async function install (maybeOpts?: PnpmOptions) {
  const reporter = maybeOpts && maybeOpts.reporter
  if (reporter) {
    streamParser.on('data', reporter)
  }

  const opts = extendOptions(maybeOpts)

  if (opts.lock) {
    await lock(opts.prefix, _install, {stale: opts.lockStaleDuration})
  } else {
    await _install()
  }

  if (reporter) {
    streamParser.removeListener('data', opts.reporter)
  }

  async function _install() {
    const installType = 'general'
    const ctx = await getContext(opts, installType)
    const installCtx = await createInstallCmd(ctx, ctx.skipped)

    if (!ctx.pkg) throw new Error('No package.json found')

    const specs = specsToInstallFromPackage(ctx.pkg, {
      prefix: opts.prefix,
    })

    if (ctx.shrinkwrap.specifiers) {
      ctx.shrinkwrap.dependencies = ctx.shrinkwrap.dependencies || {}
      ctx.shrinkwrap.devDependencies = ctx.shrinkwrap.devDependencies || {}
      ctx.shrinkwrap.optionalDependencies = ctx.shrinkwrap.optionalDependencies || {}
      for (const spec of specs) {
        if (ctx.shrinkwrap.specifiers[spec.name] !== spec.rawSpec) {
          delete ctx.shrinkwrap.dependencies[spec.name]
          delete ctx.shrinkwrap.devDependencies[spec.name]
          delete ctx.shrinkwrap.optionalDependencies[spec.name]
        }
      }
    }

    const scripts = !opts.ignoreScripts && ctx.pkg && ctx.pkg.scripts || {}

    if (scripts['prepublish']) {
      logger.warn('`prepublish` scripts are deprecated. Use `prepare` for build steps and `prepublishOnly` for upload-only.')
    }

    if (scripts['preinstall']) {
      npmRun('preinstall', ctx.root, opts.userAgent)
    }

    if (opts.lock === false) {
      await run()
    } else {
      await lock(ctx.storePath, run, {stale: opts.lockStaleDuration})
    }

    if (scripts['postinstall']) {
      npmRun('postinstall', ctx.root, opts.userAgent)
    }
    if (scripts['prepublish']) {
      npmRun('prepublish', ctx.root, opts.userAgent)
    }
    if (scripts['prepare']) {
      npmRun('prepare', ctx.root, opts.userAgent)
    }

    async function run () {
      await installInContext(installType, specs, [], ctx, installCtx, opts)
    }
  }
}

function specsToInstallFromPackage(
  pkg: Package,
  opts: {
    prefix: string,
  }
): PackageSpec[] {
  const depsToInstall = depsFromPackage(pkg)
  return depsToSpecs(depsToInstall, {
    where: opts.prefix,
    optionalDependencies: pkg.optionalDependencies || {},
    devDependencies: pkg.devDependencies || {},
  })
}

function depsFromPackage (pkg: Package): Dependencies {
  return Object.assign(
    {},
    pkg.devDependencies,
    pkg.dependencies,
    pkg.optionalDependencies
  ) as Dependencies
}

/**
 * Perform installation.
 *
 * @example
 *     install({'lodash': '1.0.0', 'foo': '^2.1.0' }, { silent: true })
 */
export async function installPkgs (fuzzyDeps: string[] | Dependencies, maybeOpts?: PnpmOptions) {
  const reporter = maybeOpts && maybeOpts.reporter
  if (reporter) {
    streamParser.on('data', reporter)
  }

  const opts = extendOptions(maybeOpts)

  if (opts.lock) {
    await lock(opts.prefix, _installPkgs, {stale: opts.lockStaleDuration})
  } else {
    await _installPkgs()
  }

  if (reporter) {
    streamParser.removeListener('data', opts.reporter)
  }

  async function _installPkgs () {
    const installType = 'named'
    const ctx = await getContext(opts, installType)
    const existingSpecs = opts.global ? {} : depsFromPackage(ctx.pkg)
    const saveType = getSaveType(opts)
    const optionalDependencies = saveType ? {} : ctx.pkg.optionalDependencies || {}
    const devDependencies = saveType ? {} : ctx.pkg.devDependencies || {}
    let packagesToInstall = Array.isArray(fuzzyDeps)
      ? argsToSpecs(fuzzyDeps, {
        defaultTag: opts.tag,
        where: opts.prefix,
        dev: opts.saveDev,
        optional: opts.saveOptional,
        existingSpecs,
        optionalDependencies,
        devDependencies,
      })
      : similarDepsToSpecs(fuzzyDeps, {
        where: opts.prefix,
        dev: opts.saveDev,
        optional: opts.saveOptional,
        existingSpecs,
        optionalDependencies,
        devDependencies,
      })

    if (!Object.keys(packagesToInstall).length) {
      throw new Error('At least one package has to be installed')
    }
    const installCtx = await createInstallCmd(ctx, ctx.skipped)

    if (ctx.shrinkwrap.dependencies) {
      for (const spec of packagesToInstall) {
        delete ctx.shrinkwrap.dependencies[spec.name]
      }
    }

    if (opts.lock === false) {
      return run()
    }

    return lock(ctx.storePath, run, {stale: opts.lockStaleDuration})

    function run () {
      return installInContext(
        installType,
        packagesToInstall,
        packagesToInstall.map(spec => spec.name),
        ctx,
        installCtx,
        opts)
    }
  }
}

function argsToSpecs (
  args: string[],
  opts: {
    defaultTag: string,
    where: string,
    dev: boolean,
    optional: boolean,
    existingSpecs: Dependencies,
    optionalDependencies: Dependencies,
    devDependencies: Dependencies,
  }
): PackageSpec[] {
  return args
    .map(arg => npa(arg, opts.where))
    .map(spec => {
      if (!spec.rawSpec && opts.existingSpecs[spec.name]) {
        return npa.resolve(spec.name, opts.existingSpecs[spec.name], opts.where)
      }
      if (spec.type === 'tag' && !spec.rawSpec) {
        spec.fetchSpec = opts.defaultTag
      }
      return spec
    })
    .map(spec => {
      spec.dev = opts.dev || !!opts.devDependencies[spec.name]
      spec.optional = opts.optional || !!opts.optionalDependencies[spec.name]
      return spec
    })
}

async function installInContext (
  installType: string,
  packagesToInstall: PackageSpec[],
  newPkgs: string[],
  ctx: PnpmContext,
  installCtx: InstallContext,
  opts: StrictPnpmOptions
) {
  const nodeModulesPath = path.join(ctx.root, 'node_modules')
  const client = new RegClient(adaptConfig(opts))

  const parts = R.partition(spec => newPkgs.indexOf(spec.name) === -1, packagesToInstall)
  const oldSpecs = parts[0]
  const newSpecs = parts[1]

  const update = opts.update || installType === 'named'
  const installOpts = {
    root: ctx.root,
    storePath: ctx.storePath,
    registry: ctx.shrinkwrap.registry,
    force: opts.force,
    depth: update ? opts.depth :
      (R.equals(ctx.shrinkwrap.packages, ctx.privateShrinkwrap.packages) ? opts.repeatInstallDepth : Infinity),
    engineStrict: opts.engineStrict,
    nodeVersion: opts.nodeVersion,
    pnpmVersion: opts.packageManager.name === 'pnpm' ? opts.packageManager.version : '',
    got: createGot(client, {
      networkConcurrency: opts.networkConcurrency,
      rawNpmConfig: opts.rawNpmConfig,
      alwaysAuth: opts.alwaysAuth,
      registry: opts.registry,
    }),
    metaCache: opts.metaCache,
    resolvedDependencies: Object.assign({}, ctx.shrinkwrap.devDependencies, ctx.shrinkwrap.dependencies, ctx.shrinkwrap.optionalDependencies),
    offline: opts.offline,
    rawNpmConfig: opts.rawNpmConfig,
    nodeModules: nodeModulesPath,
    update,
    keypath: [],
    prefix: opts.prefix,
    parentNodeId: ':/:',
    currentDepth: 0,
  }
  const nonLinkedPkgs = await pFilter(packagesToInstall,
    (spec: PackageSpec) => !spec.name || safeIsInnerLink(nodeModulesPath, spec.name, {storePath: ctx.storePath}))
  const rootPkgs = await installMultiple(
    installCtx,
    nonLinkedPkgs,
    installOpts
  )
  logger('stage').debug('resolution_done')
  const rootNodeIds = rootPkgs.map(pkg => pkg.nodeId)
  installCtx.nodesToBuild.forEach(nodeToBuild => {
    installCtx.tree[nodeToBuild.nodeId] = {
      nodeId: nodeToBuild.nodeId,
      pkg: nodeToBuild.pkg,
      children: buildTree(installCtx, nodeToBuild.nodeId, nodeToBuild.pkg.id,
        installCtx.childrenIdsByParentId[nodeToBuild.pkg.id], nodeToBuild.depth + 1, nodeToBuild.installable),
      depth: nodeToBuild.depth,
      installable: nodeToBuild.installable,
    }
  })
  const pkgs: InstalledPackage[] = R.props<TreeNode>(rootNodeIds, installCtx.tree).map(node => node.pkg)
  const pkgsToSave = (pkgs as {
    optional: boolean,
    dev: boolean,
    resolution: Resolution,
    id: string,
    version: string,
    name: string,
    specRaw: string,
  }[]).concat(installCtx.localPackages)

  let newPkg: Package | undefined = ctx.pkg
  if (installType === 'named') {
    if (!ctx.pkg) {
      throw new Error('Cannot save because no package.json found')
    }
    const pkgJsonPath = path.join(ctx.root, 'package.json')
    const saveType = getSaveType(opts)
    newPkg = await save(
      pkgJsonPath,
      <any>pkgsToSave.map(dep => { // tslint:disable-line
        const spec = R.find(spec => spec.raw === dep.specRaw, newSpecs)
        if (!spec) return null
        return {
          name: dep.name,
          saveSpec: getSaveSpec(spec, dep.version, opts.saveExact)
        }
      }).filter(Boolean),
      saveType
    )
  }

  if (newPkg) {
    ctx.shrinkwrap.dependencies = ctx.shrinkwrap.dependencies || {}
    ctx.shrinkwrap.specifiers = ctx.shrinkwrap.specifiers || {}
    ctx.shrinkwrap.optionalDependencies = ctx.shrinkwrap.optionalDependencies || {}
    ctx.shrinkwrap.devDependencies = ctx.shrinkwrap.devDependencies || {}

    const deps = newPkg.dependencies || {}
    const devDeps = newPkg.devDependencies || {}
    const optionalDeps = newPkg.optionalDependencies || {}

    const getSpecFromPkg = (depName: string) => deps[depName] || devDeps[depName] || optionalDeps[depName]

    for (const dep of pkgsToSave) {
      const ref = pkgIdToRef(dep.id, dep.name, dep.resolution, ctx.shrinkwrap.registry)
      if (dep.dev) {
        ctx.shrinkwrap.devDependencies[dep.name] = ref
      } else if (dep.optional) {
        ctx.shrinkwrap.optionalDependencies[dep.name] = ref
      } else {
        ctx.shrinkwrap.dependencies[dep.name] = ref
      }
      if (!dep.dev) {
        delete ctx.shrinkwrap.devDependencies[dep.name]
      }
      if (!dep.optional) {
        delete ctx.shrinkwrap.optionalDependencies[dep.name]
      }
      if (dep.dev || dep.optional) {
        delete ctx.shrinkwrap.dependencies[dep.name]
      }
      ctx.shrinkwrap.specifiers[dep.name] = getSpecFromPkg(dep.name)
    }
  }

  const result = await linkPackages(pkgs, rootNodeIds, installCtx.tree, {
    force: opts.force,
    global: opts.global,
    baseNodeModules: nodeModulesPath,
    bin: opts.bin,
    topParents: ctx.pkg
      ? await getTopParents(
          R.difference(R.keys(depsFromPackage(ctx.pkg)), newPkgs), nodeModulesPath)
      : [],
    shrinkwrap: ctx.shrinkwrap,
    production: opts.production,
    optional: opts.optional,
    root: ctx.root,
    privateShrinkwrap: ctx.privateShrinkwrap,
    storePath: ctx.storePath,
    skipped: ctx.skipped,
    pkg: newPkg || ctx.pkg,
    independentLeaves: opts.independentLeaves,
    storeIndex: ctx.storeIndex,
    makePartialPrivateShrinkwrap: installType === 'named' && ctx.noPrivateShrinkwrap,
  })

  await Promise.all([
    saveShrinkwrap(ctx.root, result.shrinkwrap, result.privateShrinkwrap),
    saveModules(path.join(ctx.root, 'node_modules'), {
      packageManager: `${opts.packageManager.name}@${opts.packageManager.version}`,
      store: ctx.storePath,
      skipped: Array.from(installCtx.skipped),
      layoutVersion: LAYOUT_VERSION,
      independentLeaves: opts.independentLeaves,
    }),
  ])

  // postinstall hooks
  if (!(opts.ignoreScripts || !result.newPkgResolvedIds || !result.newPkgResolvedIds.length)) {
    const limitChild = pLimit(opts.childConcurrency)
    const linkedPkgsMapValues = R.values(result.linkedPkgsMap)
    await Promise.all(
      R.props<DependencyTreeNode>(result.newPkgResolvedIds, result.linkedPkgsMap)
        .map(pkg => limitChild(async () => {
          try {
            await postInstall(pkg.hardlinkedLocation, installLogger(pkg.id), {
              userAgent: opts.userAgent
            })
          } catch (err) {
            if (installCtx.installs[pkg.id].optional) {
              logger.warn({
                message: `Skipping failed optional dependency ${pkg.id}`,
                err,
              })
              return
            }
            throw err
          }
        })
      )
    )
  }

  if (installCtx.localPackages.length) {
    const linkOpts = Object.assign({}, opts, {skipInstall: true})
    await Promise.all(installCtx.localPackages.map(async localPackage => {
      await externalLink(localPackage.resolution.directory, opts.prefix, linkOpts)
      logStatus({
        status: 'installed',
        pkgId: localPackage.id,
      })
    }))
  }

  // waiting till the skipped packages are downloaded to the store
  await Promise.all(
    R.props<InstalledPackage>(Array.from(installCtx.skipped), installCtx.installs)
      // skipped packages might have not been reanalized on a repeat install
      // so lets just ignore those by excluding nulls
      .filter(Boolean)
      .map(pkg => pkg.fetchingFiles)
  )

  // waiting till integrities are saved
  await Promise.all(R.values(installCtx.installs).map(installed => installed.calculatingIntegrity))

  logger('summary').info()
}

function buildTree (
  ctx: InstallContext,
  parentNodeId: string,
  parentId: string,
  childrenIds: string[],
  depth: number,
  installable: boolean
) {
  const childrenNodeIds = []
  for (const childId of childrenIds) {
    if (parentNodeId.indexOf(`:${parentId}:${childId}:`) !== -1) {
      continue
    }
    const childNodeId = `${parentNodeId}${childId}:`
    childrenNodeIds.push(childNodeId)
    installable = installable && !ctx.skipped.has(childId)
    ctx.tree[childNodeId] = {
      nodeId: childNodeId,
      pkg: ctx.installs[childId],
      children: buildTree(ctx, childNodeId, childId, ctx.childrenIdsByParentId[childId], depth + 1, installable),
      depth,
      installable,
    }
  }
  return childrenNodeIds
}

async function getTopParents (pkgNames: string[], modules: string) {
  const pkgs = await Promise.all(
    pkgNames.map(pkgName => path.join(modules, pkgName)).map(safeReadPkgFromDir)
  )
  return pkgs.filter(Boolean).map((pkg: Package) => ({
    name: pkg.name,
    version: pkg.version,
  }))
}

function getSaveSpec(spec: PackageSpec, version: string, saveExact: boolean) {
  switch (spec.type) {
    case 'version':
    case 'range':
    case 'tag':
      return `${saveExact ? '' : '^'}${version}`
    default:
      return spec.saveSpec
  }
}

async function createInstallCmd (
  ctx: PnpmContext,
  skipped: Set<string>
): Promise<InstallContext> {
  return {
    installs: {},
    localPackages: [],
    childrenIdsByParentId: {},
    nodesToBuild: [],
    shrinkwrap: ctx.shrinkwrap,
    privateShrinkwrap: ctx.privateShrinkwrap,
    fetchingLocker: {},
    skipped,
    tree: {},
    storeIndex: ctx.storeIndex,
  }
}

function adaptConfig (opts: StrictPnpmOptions) {
  const registryLog = logger('registry')
  return {
    proxy: {
      http: opts.proxy,
      https: opts.httpsProxy,
      localAddress: opts.localAddress
    },
    ssl: {
      certificate: opts.cert,
      key: opts.key,
      ca: opts.ca,
      strict: opts.strictSsl
    },
    retry: {
      count: opts.fetchRetries,
      factor: opts.fetchRetryFactor,
      minTimeout: opts.fetchRetryMintimeout,
      maxTimeout: opts.fetchRetryMaxtimeout
    },
    userAgent: opts.userAgent,
    log: Object.assign({}, registryLog, {
      verbose: registryLog.debug.bind(null, 'http'),
      http: registryLog.debug.bind(null, 'http'),
    }),
    defaultTag: opts.tag
  }
}

function npmRun (scriptName: string, pkgRoot: string, userAgent: string) {
  const result = runScriptSync('npm', ['run', scriptName], {
    cwd: pkgRoot,
    stdio: 'inherit',
    userAgent,
  })
  if (result.status !== 0) {
    const err = new Error(`Running event ${scriptName} failed with status ${result.status}`)
    err['code'] = 'ELIFECYCLE'
    throw err
  }
}

const lifecycleLogger = logger('lifecycle')

function installLogger (pkgId: string) {
  return (stream: string, line: string) => {
    const logLevel = stream === 'stderr' ? 'error' : 'info'
    lifecycleLogger[logLevel]({pkgId, line})
  }
}
