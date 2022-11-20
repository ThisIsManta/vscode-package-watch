import * as fs from 'fs'
import { removeSync } from 'fs-extra/lib/remove'
import * as fp from 'path'
import * as cp from 'child_process'
import * as vscode from 'vscode'
import compact from 'lodash/compact'
import uniq from 'lodash/uniq'
import uniqBy from 'lodash/uniqBy'
import sortBy from 'lodash/sortBy'
import mapValues from 'lodash/mapValues'
import findLast from 'lodash/findLast'
import debounce from 'lodash/debounce'
import trim from 'lodash/trim'
import isEqual from 'lodash/isEqual'
import * as yarn from '@yarnpkg/lockfile'
import glob from 'glob/sync'
import validRange from 'semver/ranges/valid'
import validVersion from 'semver/functions/valid'
import satisfies from 'semver/functions/satisfies'

let fileWatcher: vscode.FileSystemWatcher
let outputChannel: vscode.OutputChannel
let pendingOperation: vscode.CancellationTokenSource | null = null
const recentProblems = new Map<Report['packageJsonPath'], Report>()

class CheckingOperation extends vscode.CancellationTokenSource { }
class InstallationOperation extends vscode.CancellationTokenSource { }

export async function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('Package Watch')

	const manualIgnoreList = new PersistentPackageJsonList(context)

	const queue: Array<string> = []
	const defer = debounce(async () => {
		if (pendingOperation) {
			return
		}
		pendingOperation = new CheckingOperation()
		const token = pendingOperation.token

		if (queue.length === 0) {
			return
		}

		const packageJsonPathList = uniq(queue)
		queue.splice(0, queue.length)

		try {
			await checkDependencies(packageJsonPathList, token, true, manualIgnoreList)

		} catch (error) {
			outputChannel.appendLine(String(error))

			vscode.window.showErrorMessage(String(error))

		} finally {
			if (token === pendingOperation.token) {
				pendingOperation = null
			}
		}

		if (queue.length > 0) {
			defer()
		}
	}, 1500)
	const batch = (path: string | Array<string>) => {
		if (pendingOperation instanceof InstallationOperation) {
			return
		}

		if (typeof path === 'string') {
			queue.push(path)
		} else {
			queue.push(...path)
		}

		defer()
	}

	fileWatcher = vscode.workspace.createFileSystemWatcher('**/{package.json,package-lock.json,yarn.lock}', false, false, true)

	context.subscriptions.push(fileWatcher.onDidCreate(async link => {
		if (fp.basename(link.fsPath) === 'package.json') {
			batch(link.fsPath)
		}
	}))

	context.subscriptions.push(fileWatcher.onDidChange(async link => {
		if (fp.basename(link.fsPath) === 'package.json') {
			batch(link.fsPath)

		} else if (fp.basename(link.fsPath) === 'package-lock.json') {
			batch(fp.join(fp.dirname(link.fsPath), 'package.json'))

		} else { // In case of 'yarn.lock'
			batch(await getPackageJsonPathList())
		}
	}))

	context.subscriptions.push(vscode.commands.registerCommand('packageWatch.checkDependencies', async () => {
		if (pendingOperation) {
			pendingOperation.cancel()
		}
		pendingOperation = new CheckingOperation()
		const token = pendingOperation.token

		outputChannel.clear()

		try {
			const success = await checkDependencies(await getPackageJsonPathList(), token, false, null)

			if (success) {
				vscode.window.showInformationMessage('Dependencies synced ✅')
			}

		} catch (error) {
			outputChannel.appendLine(String(error))

			throw error

		} finally {
			if (token === pendingOperation.token) {
				pendingOperation = null
			}
		}
	}))

	context.subscriptions.push(vscode.commands.registerCommand('packageWatch.installDependencies', installDependencies))

	batch(await getPackageJsonPathList())
}

export function deactivate() {
	if (pendingOperation) {
		pendingOperation.cancel()
	}

	if (fileWatcher) {
		fileWatcher.dispose()
	}

	if (outputChannel) {
		outputChannel.dispose()
	}
}

async function getPackageJsonPathList() {
	return (await vscode.workspace.findFiles('**/package.json', '**/node_modules/**')).map(link => link.fsPath)
}

type Dependency = {
	name: string
	path: string | undefined
	expectedVersion: string
	lockedVersion: string | undefined
	actualVersion: string | undefined
}

type PackageJson = {
	name: string
	version: string
	private?: boolean
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
	bundledDependencies?: Record<string, string>

	/**
	 * @see https://classic.yarnpkg.com/lang/en/docs/workspaces/
	 * @see https://classic.yarnpkg.com/blog/2018/02/15/nohoist/
	 */
	workspaces?: Array<string> | { packages?: Array<string>; nohoist?: Array<string> }
}

async function checkDependencies(
	packageJsonPathList: Array<string>,
	token: vscode.CancellationToken,
	recentProblemsIgnored: boolean,
	manualIgnoreList: PersistentPackageJsonList | null,
) {
	const reports = createReports(packageJsonPathList, token)
	const problematicReports = reports.filter(report =>
		report.problems.length > 0 &&
		(!recentProblemsIgnored || !isEqual(recentProblems.get(report.packageJsonPath), report)) &&
		(!manualIgnoreList || !manualIgnoreList.has(report))
	)

	for (const report of reports) {
		recentProblems.set(report.packageJsonPath, report)
	}

	if (manualIgnoreList) {
		for (const report of problematicReports) {
			await manualIgnoreList.remove(report.packageJsonPath)
		}
	}

	if (token.isCancellationRequested) {
		return
	}

	if (problematicReports.length === 0) {
		return true
	}

	printReports(problematicReports, token)

	if (token.isCancellationRequested) {
		return
	}

	const totalPackageJsonCount = (await getPackageJsonPathList()).length

	const message: string = (() => {
		const containingCommonPath = getCommonPath(vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) || [])
		const containingDirectoryName = fp.basename(containingCommonPath)
		const parentCommonPath = containingCommonPath.substring(0, containingCommonPath.length - containingDirectoryName.length)
		const optionalPackageLocation = totalPackageJsonCount > 1
			? ': ' + problematicReports.map(report => trim(fp.dirname(report.packageJsonPath.substring(parentCommonPath.length)), fp.sep)).join(', ')
			: ''

		if (problematicReports.every(report => report.problems.every(problem => problem.type === 'dep-not-installed'))) {
			return 'Dependencies not installed ❌' + optionalPackageLocation
		}

		return 'Dependencies changed ❌' + optionalPackageLocation
	})()

	const options: Array<{ title: string, action: () => void }> = compact([
		{
			title: 'Install',
			action: () => {
				installDependencies(reports)
			}
		},
		manualIgnoreList && problematicReports.every(report => report.problems.every(problem => problem.type === 'dep-not-installed')) && {
			title: 'Ignore',
			action: () => {
				manualIgnoreList.add(...problematicReports)
			}
		},
		{
			title: 'Explain',
			action: () => {
				outputChannel.show()
			}
		}
	])

	vscode.window.showWarningMessage(message, ...options).then(selectOption => {
		if (selectOption) {
			selectOption.action()
		}
	})
}

type Report = {
	packageJsonPath: string
	packageJsonHash: Record<PackageJson['name'], PackageJson['version']>
	problems: Array<{
		type: 'dep-not-installed' | 'dep-version-mismatched'
		text: string
		moduleCheckingNeeded?: boolean
		modulePathForCleaningUp?: string
	}>
}

function createReports(
	packageJsonPathList: Array<string>,
	token: vscode.CancellationToken,
): Array<Report> {
	return compact(packageJsonPathList
		.filter(packageJsonPath => fp.basename(packageJsonPath) === 'package.json')
		.map((packageJsonPath): Report | null => {
			if (token.isCancellationRequested) {
				return null
			}

			const packageJson = readFile<PackageJson>(packageJsonPath)
			const expectedDependencies: Array<[PackageJson['name'], PackageJson['version']]> = compact([
				packageJson?.dependencies,
				packageJson?.devDependencies,
				packageJson?.peerDependencies,
				// TODO: add 'bundledDependencies'
			]).flatMap(item => Object.entries<PackageJson['version']>(item))

			// Skip this file as there is no dependencies written in the file
			if (expectedDependencies.length === 0) {
				return null
			}

			const packageJsonHash = Object.fromEntries(expectedDependencies)

			const dependencies: Array<Dependency> | null = (
				getDependenciesFromYarnLock(packageJsonPath, expectedDependencies) ||
				getDependenciesFromPackageLock(packageJsonPath, expectedDependencies)
			)
			if (!dependencies) {
				return {
					packageJsonPath,
					packageJsonHash,
					problems: [{
						type: 'dep-not-installed',
						text: 'A lockfile was not found alongside the package.json file.',
					}]
				}
			}

			if (dependencies.every(item => item.actualVersion === undefined)) {
				return {
					packageJsonPath,
					packageJsonHash,
					problems: [{
						type: 'dep-not-installed',
						text: 'None of the dependencies are installed.'
					}]
				}
			}

			return {
				packageJsonPath,
				packageJsonHash,
				problems: compact(dependencies.map(item => {
					if (!item.actualVersion || !validVersion(item.actualVersion)) {
						return {
							type: 'dep-not-installed',
							text: `${item.name} not installed.`
						}
					}

					if (!validRange(item.expectedVersion)) {
						return
					}

					if (item.lockedVersion && validVersion(item.lockedVersion) && !satisfies(item.lockedVersion, item.expectedVersion)) {
						return {
							type: 'dep-version-mismatched',
							text: `${item.name} ${item.expectedVersion} ≠ ${item.lockedVersion} in the lockfile.`
						}
					}

					if (item.lockedVersion && item.lockedVersion !== item.actualVersion) {
						return {
							type: 'dep-version-mismatched',
							text: `${item.name} ${item.lockedVersion} in the lockfile ≠ ${item.actualVersion} in the node_modules.`,
							moduleCheckingNeeded: true,
							modulePathForCleaningUp: item.path
						}
					}

					if (!satisfies(item.actualVersion, item.expectedVersion)) {
						return {
							type: 'dep-version-mismatched',
							text: `${item.name} ${item.expectedVersion} ≠ ${item.actualVersion} in the node_modules.`,
						}
					}
				}))
			}
		}))
}

function printReports(reports: Array<Report>, token: vscode.CancellationToken): void {
	for (const { packageJsonPath, problems } of reports) {
		if (token.isCancellationRequested) {
			return
		}

		outputChannel.appendLine('')
		outputChannel.appendLine(packageJsonPath)
		for (const problem of problems) {
			if (token.isCancellationRequested) {
				return
			}

			outputChannel.appendLine('  ' + problem.text)
		}
	}
}

function getDependenciesFromPackageLock(
	packageJsonPath: string,
	expectedDependencies: Array<[PackageJson['name'], PackageJson['version']]>,
): Array<Dependency> | null {
	const packageLockPath = fp.join(fp.dirname(packageJsonPath), 'package-lock.json')
	const packageLockFile = readFile<{
		lockfileVersion?: number
		packages?: Record<string, { version: string }>
		dependencies?: Record<string, { version: string }>
	}>(packageLockPath)

	if (packageLockFile === null) {
		return null
	}

	const nameVersionHash = ((): Record<string, string | undefined> => {
		// See https://docs.npmjs.com/cli/v9/configuring-npm/package-lock-json#packages
		if (packageLockFile.packages) {
			const topLevelModuleDirectory = /^node_modules\//

			return Object.fromEntries(
				Object.entries(packageLockFile.packages)
					.map(([path, { version }]) => [path.replace(topLevelModuleDirectory, ''), version])
			)
		}

		if (packageLockFile.dependencies) {
			return mapValues(packageLockFile.dependencies, ({ version }) => version)
		}

		throw new Error(`Could not find neither "packages" nor "dependencies" field in ${packageLockPath}`)
	})()

	return expectedDependencies.map(([name, expectedVersion]) => {
		const lockedVersion = nameVersionHash[name]

		const modulePath = fp.join(fp.dirname(packageJsonPath), 'node_modules', name, 'package.json')
		const actualVersion = readFile<PackageJson>(modulePath)?.version

		return {
			name,
			path: fp.dirname(modulePath),
			expectedVersion,
			lockedVersion,
			actualVersion,
		}
	})
}

function getDependenciesFromYarnLock(
	packageJsonPath: string,
	expectedDependencies: Array<[PackageJson['name'], PackageJson['version']]>,
): Array<Dependency> | null {
	const yarnLockPath = findFileInParentDirectory(fp.dirname(packageJsonPath), 'yarn.lock')
	if (!yarnLockPath) {
		return null
	}

	// Stop processing if the current directory is not part of the Yarn Workspace
	if (fp.dirname(yarnLockPath) !== fp.dirname(packageJsonPath) && !checkYarnWorkspace(packageJsonPath, yarnLockPath)) {
		return null
	}

	const nameObjectHash = readFile<{ object: { [key: string]: { version: string } } }>(yarnLockPath)?.object || {}
	const nameVersionHash = mapValues(nameObjectHash, item => item.version)

	return expectedDependencies.map(([name, expectedVersion]) => {
		const lockedVersion = (
			nameVersionHash[name + '@' + expectedVersion] ||
			findLast(nameVersionHash, (version, nameAtVersion) => nameAtVersion.startsWith(name + '@'))
		)

		const modulePath = findFileInParentDirectory(
			fp.dirname(packageJsonPath),
			fp.join('node_modules', name, 'package.json'),
			fp.dirname(yarnLockPath)
		)
		const actualVersion = modulePath ? readFile<PackageJson>(modulePath)?.version : undefined

		return {
			name,
			path: modulePath ? fp.dirname(modulePath) : undefined,
			expectedVersion,
			lockedVersion,
			actualVersion,
		}
	})
}

/**
 * @see https://yarnpkg.com/lang/en/docs/workspaces/
 */
function checkYarnWorkspace(packageJsonPath: string, yarnLockPath: string): boolean {
	if (!packageJsonPath || !yarnLockPath) {
		return false
	}

	const packageJsonForYarnWorkspace = readFile<PackageJson>(fp.join(fp.dirname(yarnLockPath), 'package.json'))
	if (!packageJsonForYarnWorkspace || packageJsonForYarnWorkspace.private !== true || !packageJsonForYarnWorkspace.workspaces) {
		return false
	}

	const yarnWorkspacePathList = (
		Array.isArray(packageJsonForYarnWorkspace.workspaces)
			? packageJsonForYarnWorkspace.workspaces
			: packageJsonForYarnWorkspace.workspaces.packages || []
	)
		.flatMap(pathOrGlob => glob(pathOrGlob, { cwd: fp.dirname(yarnLockPath), absolute: true }))
		.map(path => path.replace(/\//g, fp.sep))
	if (yarnWorkspacePathList.includes(fp.dirname(packageJsonPath))) {
		return true
	}

	return false
}

function findFileInParentDirectory(
	path: string,
	name: string,
	stopPath?: string,
): string | undefined {
	const pathList = path.split(fp.sep)
	while (pathList.length > 1) {
		const workPath = fp.join(...pathList, name)

		if (stopPath && workPath.startsWith(stopPath) === false) {
			break
		}

		const fileStat = fs.lstatSync(workPath, { throwIfNoEntry: false })
		if (fileStat?.isFile()) {
			return workPath
		}

		pathList.pop()
	}
}

function readFile<T>(filePath: string): T | null {
	try {
		const text = fs.readFileSync(filePath, 'utf-8')
		if (fp.extname(filePath) === '.json') {
			return JSON.parse(text)
		} else if (fp.basename(filePath) === 'yarn.lock') {
			return yarn.parse(text)
		}
		return text as any

	} catch (error) {
		return null
	}
}

async function installDependencies(reports: Array<Report> = [], secondTry = false) {
	if (pendingOperation instanceof CheckingOperation) {
		pendingOperation.cancel()
	} else if (pendingOperation instanceof InstallationOperation) {
		return
	}
	pendingOperation = new InstallationOperation()
	const token = pendingOperation.token

	outputChannel.clear()

	if (token.isCancellationRequested) {
		return
	}

	if (vscode.workspace.workspaceFolders === undefined) {
		vscode.window.showErrorMessage('Workspaces not opened 🙄', { modal: true })
		pendingOperation = null
		return
	}

	const packageJsonPathList = reports.length === 0
		? await getPackageJsonPathList()
		: reports.map(report => report.packageJsonPath)

	if (token.isCancellationRequested) {
		return
	}

	if (packageJsonPathList.length === 0) {
		vscode.window.showErrorMessage('package.json not found 🙄', { modal: true })
		pendingOperation = null
		return
	}

	const success = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Installing dependencies... 🚧', cancellable: true }, async (progress, progressToken) => {
		progressToken.onCancellationRequested(() => {
			if (token === pendingOperation?.token) {
				pendingOperation.cancel()
				pendingOperation = null
			}
		})

		const problems = reports.flatMap(report => report.problems)

		// Remove the problematic modules from /node_module/ so `--check-files` will work
		for (const problem of problems) {
			if (
				problem.modulePathForCleaningUp &&
				fs.existsSync(problem.modulePathForCleaningUp) &&
				fp.basename(fp.dirname(problem.modulePathForCleaningUp)) === 'node_modules'
			) {
				try {
					removeSync(problem.modulePathForCleaningUp)
				} catch (error) {
					// Do nothing
				}
			}
		}

		const moduleCheckingNeeded = problems.some(problem => problem.moduleCheckingNeeded)

		const totalCommands = compact(
			packageJsonPathList
				.map(packageJsonPath => {
					if (token.isCancellationRequested) {
						return
					}

					const yarnLockPath = findFileInParentDirectory(fp.dirname(packageJsonPath), 'yarn.lock')
					if (
						fs.existsSync(fp.join(fp.dirname(packageJsonPath), 'yarn.lock')) ||
						yarnLockPath && checkYarnWorkspace(packageJsonPath, yarnLockPath) ||
						cp.spawnSync('which', ['yarn']).status === 0 && fs.existsSync(fp.join(fp.dirname(packageJsonPath), 'package-lock.json')) === false
					) {
						return {
							command: 'yarn install',
							parameters: [(moduleCheckingNeeded || secondTry) && '--check-files', secondTry && '--force'],
							directory: fp.dirname(yarnLockPath || packageJsonPath),
							packageJsonPath,
						}

					} else {
						return {
							command: 'npm install',
							parameters: [secondTry && '--force'],
							directory: fp.dirname(packageJsonPath),
							packageJsonPath,
						}
					}
				})
		).map(item => ({ ...item, parameters: compact(item.parameters) }))

		const uniqueCommands = uniqBy(totalCommands, ({ directory }) => directory)
		const sortedCommands = sortBy(uniqueCommands, ({ directory }) => directory.length)

		const progressWidth = 100 / sortedCommands.length

		for (const { command, parameters, directory, packageJsonPath } of sortedCommands) {
			if (token.isCancellationRequested) {
				return
			}

			outputChannel.appendLine('')
			outputChannel.appendLine(packageJsonPath.replace(/\\/g, '/'))

			let nowStep = 0
			let maxStep = 1

			const exitCode = await new Promise<number>(resolve => {
				const worker = cp.spawn(command, parameters, { cwd: directory, shell: true })
				worker.stdout.on('data', text => {
					outputChannel.append('  ' + text)

					if (command === 'yarn install') {
						const steps = text.toString().match(/^\[(\d)\/(\d)\]\s/)
						if (steps) {
							maxStep = +steps[2]
							progress.report({ increment: Math.floor((+steps[1] - nowStep) / maxStep * progressWidth) })
							nowStep = +steps[1]
						}
					}
				})
				worker.stderr.on('data', text => {
					outputChannel.append('  ' + text)
				})
				worker.on('exit', code => {
					progress.report({ increment: Math.floor((maxStep - nowStep) / maxStep * progressWidth) })

					resolve(code ?? 0)
				})

				token.onCancellationRequested(() => {
					worker.kill()
				})
			})

			if (token.isCancellationRequested) {
				return
			}

			if (exitCode !== 0) {
				vscode.window.showErrorMessage(
					`Error running "${command}" 💥`,
					{
						title: 'Explain',
						action: () => {
							outputChannel.show()
						}
					}
				).then(selectOption => {
					if (selectOption) {
						selectOption.action()
					}
				})
				return
			}
		}

		return true
	})

	if (token === pendingOperation.token) {
		pendingOperation = null
	}

	if (token.isCancellationRequested) {
		return
	}

	if (!success) {
		return
	}

	if (secondTry) {
		return
	}

	const verifiedReports = createReports(packageJsonPathList, token)
	const problematicReports = verifiedReports.filter(review => review.problems.length > 0)

	printReports(problematicReports, token)

	if (problematicReports.length > 0) {
		vscode.window.showWarningMessage(
			'Error installing dependencies 💥',
			{
				title: 'Clean Install',
				action: () => {
					installDependencies(problematicReports, true)
				}
			},
			{
				title: 'Explain',
				action: () => {
					outputChannel.show()
				}
			},
		).then(selectOption => {
			if (selectOption) {
				selectOption.action()
			}
		})

	} else {
		vscode.window.showInformationMessage('Dependencies synced ✅')
	}
}

function getCommonPath(pathList: Array<string>): string {
	if (pathList.length === 0) {
		return ''
	}

	if (pathList.length === 1) {
		return pathList[0]
	}

	const commonPath: Array<string> = pathList[0].split(fp.sep)
	for (const path of pathList.slice(1)) {
		while (commonPath.length > 0 && !path.startsWith(fp.join(...commonPath) + fp.sep)) {
			commonPath.pop()
		}
	}
	return fp.join(...commonPath)
}

class PersistentPackageJsonList {
	private static key = 'SkipList:'
	private state: vscode.Memento

	constructor(context: vscode.ExtensionContext) {
		this.state = context.workspaceState
	}

	has(report: Pick<Report, 'packageJsonPath' | 'packageJsonHash'>): boolean {
		const value = this.state.get<Report['packageJsonHash']>(PersistentPackageJsonList.key + report.packageJsonPath)
		return !!value && isEqual(value, report.packageJsonHash)
	}

	async add(...reports: Array<Pick<Report, 'packageJsonPath' | 'packageJsonHash'>>) {
		for (const { packageJsonPath, packageJsonHash } of reports) {
			await this.state.update(PersistentPackageJsonList.key + packageJsonPath, packageJsonHash)
		}
	}

	async remove(...packageJsonPathList: Array<Report['packageJsonPath']>) {
		for (const packageJsonPath of packageJsonPathList) {
			await this.state.update(PersistentPackageJsonList.key + packageJsonPath, undefined)
		}
	}
}
