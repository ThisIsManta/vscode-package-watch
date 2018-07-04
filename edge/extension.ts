import * as fs from 'fs'
import * as fp from 'path'
import * as ps from 'process'
import * as cp from 'child_process'
import * as vscode from 'vscode'
import * as _ from 'lodash'
import * as yarn from '@yarnpkg/lockfile'
import * as glob from 'glob'

let fileWatcher: vscode.FileSystemWatcher
let outputChannel: vscode.OutputChannel
let pendingOperation: vscode.CancellationTokenSource

export async function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Package Watch')

    const queue: Array<string> = []
    const defer = _.debounce(async () => {
        if (pendingOperation) {
            return
        }
        pendingOperation = new vscode.CancellationTokenSource()
        const token = pendingOperation.token

        const packageJsonPathList = _.uniq(queue)
        queue.splice(0, queue.length)

        await checkDependencies(packageJsonPathList, token)

        pendingOperation = null
    }, 300)
    const batch = (path: string | Array<string>) => {
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
            batch(fp.join(fp.basename(link.fsPath), 'package.json'))

        } else {
            // TODO: use Yarn Workspace
            batch(await getPackageJsonPathList())
        }
    }))

    context.subscriptions.push(vscode.commands.registerCommand('packageWatch.checkDependencies', async () => {
        if (pendingOperation) {
            pendingOperation.cancel()
        }
        pendingOperation = new vscode.CancellationTokenSource()
        const token = pendingOperation.token

        outputChannel.clear()

        const success = await checkDependencies(await getPackageJsonPathList(), token)
        if (success) {
            vscode.window.showInformationMessage('The node dependencies are updated.')
        }

        pendingOperation = null
    }))

    context.subscriptions.push(vscode.commands.registerCommand('packageWatch.installDependencies', async (packageJsonPathList: Array<string>) => {
        if (pendingOperation) {
            vscode.window.showInformationMessage('The dependency checking/installation is in progress.', { modal: true })
            return
        }
        pendingOperation = new vscode.CancellationTokenSource()
        const token = pendingOperation.token

        outputChannel.clear()

        await installDependencies(packageJsonPathList, { forceChecking: true }, token)

        if (token.isCancellationRequested) {
            return
        }

        pendingOperation = null
    }))

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
    return (await vscode.workspace.findFiles('**/package.json')).map(link => link.fsPath)
}

type Report = {
    packageJsonPath: string
    problems: Array<string>
}

async function checkDependencies(packageJsonPathList: Array<string>, token: vscode.CancellationToken) {
    const reports = createReports(packageJsonPathList, token)

    if (token.isCancellationRequested) {
        return
    }

    if (reports.length === 0) {
        return true
    }

    printReports(reports, token)

    if (token.isCancellationRequested) {
        return
    }

    const problems = _.chain(reports)
        .map(report => report.problems)
        .flatten()
        .value()
    let message = 'One or more node package dependencies were outdated.'
    let forceChecking = true
    if (problems.every(problem => problem === 'The lock file was missing.' || problem.includes('was not installed.'))) {
        message = 'One or more node package dependencies needed to be installed.'
        forceChecking = false
    } else if (problems.some(problem => problem.includes('was not found in /node_module/ directory.'))) {
        message = 'One or more node package dependencies were missing from /node_module/ directory.'
    }

    const selectOption = await vscode.window.showWarningMessage(
        message,
        {
            title: 'Install Dependencies',
            action: () => installDependencies(reports.map(report => report.packageJsonPath), { forceChecking }, token)
        },
        {
            title: 'Show Problems',
            action: () => { outputChannel.show() }
        }
    )

    if (token.isCancellationRequested) {
        return
    }

    if (selectOption) {
        await selectOption.action()
    }

    if (token.isCancellationRequested) {
        return
    }
}

function createReports(packageJsonPathList: Array<string>, cancellationToken: vscode.CancellationToken) {
    const reports: Array<Report> = []
    for (const packageJsonPath of packageJsonPathList) {
        if (fp.basename(packageJsonPath) !== 'package.json') {
            continue
        }

        if (cancellationToken.isCancellationRequested) {
            return
        }

        const expectedDependencies = _.chain(readFile(packageJsonPath) as object)
            .pick(['dependencies', 'devDependencies', 'peerDependencies']) // TODO: add 'bundledDependencies'
            .values()
            .map(item => _.toPairs<string>(item))
            .flatten()
            .value()

        const dependencies = (
            getDependenciesFromYarnLock(packageJsonPath, expectedDependencies) ||
            getDependenciesFromPackageLock(packageJsonPath, expectedDependencies)
        )
        if (!dependencies) {
            reports.push({
                packageJsonPath,
                problems: ['The lock file was missing.']
            })
            continue
        }

        reports.push({
            packageJsonPath,
            problems: _.compact(dependencies.map(item => {
                if (!item.lockedVersion && !item.actualVersion) {
                    return `"${item.name}" was not installed.`
                }

                if (!item.lockedVersion) {
                    return `"${item.name}" was not found in the lock file.`
                }

                if (!item.actualVersion) {
                    return `"${item.name}" was not found in /node_module/ directory.`
                }

                if (item.lockedVersion !== item.actualVersion) {
                    return `"${item.name}" had a mismatched version (${item.lockedVersion} vs ${item.actualVersion}).`
                }
            }))
        })
    }
    return reports.filter(report => report.problems.length > 0)
}

function printReports(reports: Array<Report>, token: vscode.CancellationToken) {
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

            outputChannel.appendLine('  ' + problem)
        }
    }
}

function getDependenciesFromPackageLock(packageJsonPath: string, expectedDependencies: Array<[string, string]>) {
    const packageLockPath = fp.join(fp.dirname(packageJsonPath), 'package-lock.json')
    if (!fs.existsSync(packageLockPath)) {
        return null
    }

    const depsData = _.get(readFile(packageLockPath), 'dependencies', {}) as { [key: string]: { version: string } }
    const depsHash = _.mapValues(depsData, item => item.version)

    return expectedDependencies.map(([name, expectedVersion]) => {
        const lockedVersion = depsHash[name]

        const modulePath = fp.join(fp.dirname(packageJsonPath), 'node_modules', name, 'package.json')
        const actualVersion = _.get(readFile(modulePath), 'version') as string

        return { name, expectedVersion, lockedVersion, actualVersion }
    })
}

function getDependenciesFromYarnLock(packageJsonPath: string, expectedDependencies: Array<[string, string]>) {
    const yarnLockPath = findName(fp.dirname(packageJsonPath), 'yarn.lock')
    if (!yarnLockPath) {
        return null
    }

    // Stop processing if the current directory is not part of a Yarn Workspace
    if (fp.dirname(yarnLockPath) !== fp.dirname(packageJsonPath) && !checkYarnWorkspace(packageJsonPath, yarnLockPath)) {
        return null
    }

    const depsData = _.get(readFile(yarnLockPath), 'object', {}) as { [key: string]: { version: string } }
    const depsHash = _.mapValues(depsData, item => item.version)

    return expectedDependencies.map(([name, expectedVersion]) => {
        const lockedVersion = (
            depsHash[name + '@' + expectedVersion] ||
            _.findLast(depsHash, (version, nameAtVersion) => nameAtVersion.startsWith(name + '@'))
        )

        const modulePath = findName(
            fp.dirname(packageJsonPath),
            fp.join('node_modules', name, 'package.json'),
            fp.dirname(yarnLockPath)
        )
        const actualVersion = _.get(readFile(modulePath), 'version') as string

        return { name, expectedVersion, lockedVersion, actualVersion }
    })
}

function checkYarnWorkspace(packageJsonPath: string, yarnLockPath: string) {
    if (!packageJsonPath || !yarnLockPath) {
        return false
    }

    // See https://yarnpkg.com/lang/en/docs/workspaces/
    const packageJsonForYarnWorkspace = readFile(fp.join(fp.dirname(yarnLockPath), 'package.json')) as { private?: boolean, workspaces?: Array<string> }
    if (packageJsonForYarnWorkspace.private !== true || !packageJsonForYarnWorkspace.workspaces) {
        return false
    }

    const yarnWorkspacePathList = _.chain(packageJsonForYarnWorkspace.workspaces)
        .map(pathOrGlob => glob.sync(pathOrGlob, { cwd: fp.dirname(yarnLockPath), absolute: true }))
        .flatten()
        .map(path => path.replace(/\//g, fp.sep))
        .value()
    if (_.includes(yarnWorkspacePathList, fp.dirname(packageJsonPath))) {
        return true
    }

    return false
}

function findName(path: string, name: string, stop?: string) {
    const pathList = path.split(fp.sep)
    while (pathList.length > 1) {
        const workPath = fp.join(...pathList, name)
        if (stop && workPath.startsWith(stop) === false) {
            break
        }
        if (fs.existsSync(workPath)) {
            return workPath
        }
        pathList.pop()
    }
}

function readFile(filePath: string): object | string {
    try {
        const text = fs.readFileSync(filePath, 'utf-8')
        if (fp.extname(filePath) === '.json') {
            return JSON.parse(text)
        } else if (fp.basename(filePath) === 'yarn.lock') {
            return yarn.parse(text)
        }
        return text

    } catch (error) {
        return null
    }
}

async function installDependencies(packageJsonPathList: Array<string>, options: { forceChecking?: boolean, forceDownloading?: boolean }, token: vscode.CancellationToken) {
    if (token.isCancellationRequested) {
        return
    }

    if (vscode.workspace.workspaceFolders === undefined) {
        vscode.window.showErrorMessage('No workspaces opened.', { modal: true })
        return
    }

    const abort = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Installing dependencies...', cancellable: true }, async (progress, progressToken) => {
        progressToken.onCancellationRequested(() => {
            if (token === pendingOperation.token) {
                pendingOperation.cancel()
                pendingOperation = null
            }
        })

        packageJsonPathList = packageJsonPathList || await getPackageJsonPathList()

        if (token.isCancellationRequested) {
            return
        }

        if (packageJsonPathList.length === 0) {
            vscode.window.showErrorMessage('No "package.json" found.', { modal: true })
            return true
        }

        const commands = _.chain(packageJsonPathList)
            .map(packageJsonPath => {
                if (token.isCancellationRequested) {
                    return null
                }

                const yarnLockPath = findName(fp.dirname(packageJsonPath), 'yarn.lock')
                if (
                    fs.existsSync(fp.join(fp.dirname(packageJsonPath), 'yarn.lock')) ||
                    checkYarnWorkspace(packageJsonPath, yarnLockPath) ||
                    cp.spawnSync('which', ['yarn']).status === 0
                ) {
                    return {
                        command: 'yarn install',
                        parameters: [options.forceChecking && '--check-files', options.forceDownloading && '--force'],
                        directory: fp.dirname(yarnLockPath),
                        packageJsonPath,
                    }

                } else {
                    return {
                        command: 'npm install',
                        parameters: [options.forceDownloading && '--force'],
                        directory: fp.dirname(packageJsonPath),
                        packageJsonPath,
                    }
                }
            })
            .compact()
            .map(item => ({ ...item, parameters: _.compact(item.parameters) }))
            .uniqBy(({ directory }) => directory)
            .sortBy(({ directory }) => directory.length)
            .value()

        for (const { command, parameters, directory, packageJsonPath } of commands) {
            if (token.isCancellationRequested) {
                return
            }

            outputChannel.appendLine('')
            outputChannel.appendLine(packageJsonPath.replace(/\\/g, '/'))

            const exitCode = await new Promise<number>(resolve => {
                const worker = cp.spawn(command, parameters, { cwd: directory, shell: true })
                worker.stdout.on('data', text => {
                    outputChannel.append('  ' + text)
                })
                worker.stderr.on('data', text => {
                    outputChannel.append('  ' + text)
                })
                worker.on('exit', code => {
                    resolve(code)
                })
            })

            if (exitCode !== 0) {
                const selectOption = await vscode.window.showErrorMessage(
                    `There was an error running "${command}".`,
                    { title: 'Show Errors', action: () => { outputChannel.show() } }
                )
                if (selectOption) {
                    selectOption.action()
                }
                return true
            }
        }
    })

    if (abort) {
        return
    }

    if (token.isCancellationRequested) {
        return
    }

    if (options.forceDownloading) {
        return
    }

    const reports = await createReports(packageJsonPathList, token)
    printReports(reports, token)
    if (reports.length > 0) {
        const selectOption = await vscode.window.showErrorMessage(
            'There were still some problems regarding the node dependencies.',
            {
                title: 'Reinstall Dependencies',
                action: () => installDependencies(reports.map(report => report.packageJsonPath), { forceChecking: true, forceDownloading: true }, token)
            },
            {
                title: 'Show Problems',
                action: () => { outputChannel.show() }
            },
        )
        if (selectOption) {
            await selectOption.action()
        }

    } else {
        vscode.window.showInformationMessage('The node dependencies are installed successfully.')
    }
}