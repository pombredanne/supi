import installChecks = require('pnpm-install-checks')
import logger from 'pnpm-logger'
import {Package} from '../types'
import {FetchedPackage} from 'package-store'

const installCheckLogger = logger('install-check')

export default async function getIsInstallable (
  pkgId: string,
  pkg: Package,
  fetchedPkg: FetchedPackage,
  options: {
    optional: boolean,
    engineStrict: boolean,
    nodeVersion: string,
    pnpmVersion: string,
  }
): Promise<boolean> {
  const warn = await installChecks.checkPlatform(pkg) || await installChecks.checkEngine(pkg, {
    pnpmVersion: options.pnpmVersion,
    nodeVersion: options.nodeVersion
  })

  if (!warn) return true

  installCheckLogger.warn(warn)

  if (options.optional) {
    logger.warn({
      message: `Skipping failed optional dependency ${pkgId}`,
      warn,
    })

    return false
  }

  if (options.engineStrict) throw warn

  return true
}
