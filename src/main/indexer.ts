import fetch from 'node-fetch'
import * as path from 'path'
import * as cp from 'child_process'
import log from 'electron-log'
import { Semaphore } from 'await-semaphore'
import { ipcMain, IpcMainInvokeEvent, session , BrowserWindow } from 'electron'
import _ from 'lodash'
import Store from 'electron-store'
import crypto from 'crypto'
// import gi from 'gitignore';

import { fileSystem } from './fileSystem'
import { promisify } from 'util'

const store = new Store()

const PATHS_TO_IGNORE_REGEX: RegExp[] = [
    /.*\/python\d\.\d\/.*/,
    /.*\/dist\/.*/,
    /.*\/bin\/.*/,
    /.*\/lib\/.*/,
    /.*\/build\/.*/,
    /.*\/\.egg-info\/.*/,
    /.*\/\.venv\/.*/,
    /.*\/node_modules\/.*/,
    /.*\/__pycache__\/.*/,
    // Generated by gpt3 below
    /.*\/\.vscode\/.*/,
    /.*\/\.idea\/.*/,
    /.*\/\.vs\/.*/,
    /.*\/\.next\/.*/,
    /.*\/\.nuxt\/.*/,
    /.*\/\.cache\/.*/,
    /.*\/\.sass-cache\/.*/,
    /.*\/\.gradle\/.*/,
    /.*\/\.DS_Store\/.*/,
    /.*\/\.ipynb_checkpoints\/.*/,
    /.*\/\.pytest_cache\/.*/,
    /.*\/\.mypy_cache\/.*/,
    /.*\/\.tox\/.*/,
    /.*\/\.git\/.*/,
    /.*\/\.hg\/.*/,
    /.*\/\.svn\/.*/,
    /.*\/\.bzr\/.*/,
    /.*\/\.lock-wscript\/.*/,
    /.*\/\.wafpickle-[0-9]*\/.*/,
    /.*\/\.lock-waf_[0-9]*\/.*/,
    /.*\/\.Python\/.*/,
    /.*\/\.jupyter\/.*/,
    /.*\/\.vscode-test\/.*/,
    /.*\/\.history\/.*/,
    /.*\/\.yarn\/.*/,
    /.*\/\.yarn-cache\/.*/,
    /.*\/\.eslintcache\/.*/,
    /.*\/\.parcel-cache\/.*/,
    /.*\/\.cache-loader\/.*/,
    /.*\/\.nyc_output\/.*/,
    /.*\/\.node_repl_history\/.*/,
    /.*\/\.pnp.js\/.*/,
    /.*\/\.pnp\/.*/,
]

async function checkStatus(repoId: string, apiRoot: string, rootDir: string) {
    return await fetch(`${apiRoot}/repos/${repoId}/status`, {
        headers: {
            Cookie: `repo_path=${rootDir}`,
        },
    }).then(
        async (res) => {
            if (res.status == 400) {
                return 'notFound'
            } else if (res.status != 200) {
                return 'error'
            }

            const { status } = (await res.json()) as { status: string }
            return status
        },
        (err) => {
            return 'error'
        }
    )
}

export class CodebaseIndexer {
    private isCancelled: boolean
    private options: {
        endpoint: string
        supportedExtensions: Set<string>
    }
    private numFiles = 0
    private numFilesToDelete = 0
    private filesUploaded = 0
    private semaphore: Semaphore = new Semaphore(20)
    public finishedUpload = false
    private haveStartedWatcher = false

    constructor(
        public rootDir: string,
        private apiRoute: string,
        private win: BrowserWindow,
        private repoId?: string
    ) {
        this.rootDir = rootDir
        this.isCancelled = false
        this.options = {
            endpoint: this.apiRoute + '/upload/repos/private',
            supportedExtensions: new Set([
                'py',
                'ts',
                'tsx',
                'js',
                'jsx',
                'go',
                'java',
                'scala',
                'rb',
                'php',
                'cs',
                'cpp',
                'c',
                'h',
                'hpp',
                'hxx',
                'cc',
                'hh',
                'cxx',
                'm',
                'mm',
                'swift',
                'rs',
                'kt',
                'kts',
                'clj',
                'cljc',
                'cljs',
                'md',
                'html',
                'css',
                'scss',
                'less',
                'sass',
                'txt',
                'json',
                'yaml',
                'yml',
                'xml',
                'toml',
                'ini',
                'conf',
                'config',
                'dockerfile',
                'dockerfile',
                'sh',
                'bash',
                'zsh',
                'fish',
                'bat',
                'ps1',
                'psm1',
            ]),
        }
        // this.options = Object.assign(defaults, options);
    }

    isInBadDir(itemPath: string) {
        return (
            (itemPath.includes('node_modules') || itemPath.includes('.git')) &&
            !(itemPath.endsWith('.git') || itemPath.endsWith('node_modules'))
        )
    }

    async isBadFile(itemPath: string) {
        if (
            !this.options.supportedExtensions.has(
                path.extname(itemPath).slice(1)
            ) ||
            path.basename(itemPath) === 'package-lock.json' ||
            path.basename(itemPath) === 'yarn.lock' ||
            itemPath.includes('.git')
        )
            return true

        // check if regex match with PATHS_TO_IGNORE_REGEX
        if (PATHS_TO_IGNORE_REGEX.some((regex) => regex.test(itemPath))) {
            return true
        }
        // if any parent folders have dot in front of them, then ignore
        const parts = itemPath.split(path.sep)
        for (let i = 0; i < parts.length; i++) {
            if (parts[i].startsWith('.')) {
                return true
            }
        }

        // Check the size of the file with fs
        // const {size} = await fileSystem.statSync(itemPath);
        //
        // // If the size is greater than 1MB, don't index it
        // if (size > 1024 * 1024) {
        //     return true;
        // }
        return false
    }

    startWatcher() {
        if (this.haveStartedWatcher) return
        this.haveStartedWatcher = true

        const rootDir = this.rootDir
        fileSystem.startWatcher(
            rootDir,
            (path: string) => {
                return this.isInBadDir(path)
            },
            {
                add: async (path: string) => {
                    // check if node_modules or .git in path
                    if (this.isInBadDir(path)) return
                    this.win.webContents.send('fileWasAdded', path)
                },
                addDir: async (path: string) => {
                    if (this.isInBadDir(path)) return
                    this.win.webContents.send('folderWasAdded', path)
                },
                change: async (path: string) => {
                    if (this.isInBadDir(path)) return
                    this.win.webContents.send('fileWasUpdated', path)
                },
                unlink: async (path: string) => {
                    if (this.isInBadDir(path)) return
                    this.win.webContents.send('fileWasDeleted', path)
                },
                unlinkDir: async (path: string) => {
                    if (this.isInBadDir(path)) return
                    this.win.webContents.send('folderWasDeleted', path)
                },
            }
        )
    }

    cancel() {
        this.isCancelled = true
    }
    async listIgnoredFiles() {
        const gitignoredFiles = new Set<string>()
        const gitSubmoduleFiles = new Set<string>()
        try {
            // TODO: There's probably a more principled way to do this, using the
            // vscode scm APIs or API of the builtin git extension.
            // Need to paginate here because the response can be huge.
            let batchNum = 1
            const batchSize = 10000

            while (true) {
                const gitCmd =
                    'git ls-files --others --ignored --exclude-standard'
                const paginateCmd = `head -n ${
                    batchNum * batchSize
                } | tail -n ${batchSize}`
                const execCmd = `${gitCmd} | ${paginateCmd}`
                const cmdResult = (
                    await promisify(cp.exec)(execCmd, { cwd: this.rootDir })
                ).stdout
                //const cmdResult = (await fileSystem.execPromise(execCmd, this.rootDir)) as string;
                const files = cmdResult
                    .split('\n')
                    // The result will have one empty string; filter it out.
                    .filter((filename: any) => filename.length > 0)
                // If we have fewer than `batchSize` new files to ignore, we're done.
                files.forEach((file: any) =>
                    gitignoredFiles.add(path.join(this.rootDir, file))
                )
                if (gitignoredFiles.size < batchNum * batchSize) {
                    break
                }
                batchNum++
            }
            batchNum = 1
            while (true) {
                const gitCmd = `git submodule foreach --quiet \'git ls-files | sed "s|^|$path/|"\'`
                const paginateCmd = `head -n ${
                    batchNum * batchSize
                } | tail -n ${batchSize}`
                const execCmd = `${gitCmd} | ${paginateCmd}`
                const cmdResult = (
                    await promisify(cp.exec)(execCmd, { cwd: this.rootDir })
                ).stdout

                const files = cmdResult
                    .split('\n')
                    // The result will have one empty string; filter it out.
                    .filter((filename: any) => filename.length > 0)
                // If we have fewer than `batchSize` new files to ignore, we're done.
                files.forEach((file: any) =>
                    gitSubmoduleFiles.add(path.join(this.rootDir, file))
                )
                if (gitSubmoduleFiles.size < batchNum * batchSize) {
                    break
                }
                batchNum++
            }
        } finally {
            const allIgnores = new Set([
                ...gitignoredFiles,
                ...gitSubmoduleFiles,
            ])
            // Get all ignore files with 'train' in it
            return allIgnores
        }
    }
    async listFiles() {
        if (fileSystem.isRemote || !store.get('uploadPreferences')) return []
        const ignoredFiles = await this.listIgnoredFiles()
        const listRecursive = async (folderPath: string) => {
            let folderContents
            try {
                folderContents = await fileSystem.readdirSyncWithIsDir(
                    folderPath
                )
            } catch (e) {
                return []
            }
            let files: string[] = []
            // TODO: Handle symlinks. (Right now we'll ignore them.)
            for (const { isDir, fileName, size } of folderContents) {
                const itemPath = path.join(folderPath, fileName)
                if (!isDir) {
                    if (
                        ignoredFiles.has(itemPath) ||
                        size > 1024 * 1024 ||
                        (await this.isBadFile(itemPath))
                    ) {
                        //   log.info('extension ' + path.extname(itemPath).slice(1))
                        //   log.info('BAD FILE: ' + itemPath)
                    } else {
                        files.push(itemPath)
                    }
                } else {
                    // Don't recurse into git directory.
                    if (fileName === '.git') {
                        continue
                    } else if (fileName === 'node_modules') {
                        continue
                    } else if (fileName === 'build') {
                        continue
                    } else if (fileName == 'out') {
                        continue
                    }
                    files = files.concat(await listRecursive(itemPath))
                }
            }
            return files
        }
        const res = await listRecursive(this.rootDir)
        // get the first 1000 files
        return res.slice(0, 1000)
    }

    async updateFilesIfNeeded(files: string[], repoId: string) {
        if (fileSystem.isRemote || !store.get('uploadPreferences')) return []
        this.repoId = repoId
        this.numFiles = files.length
        const uploadFilesBatch = async (files: string[]) => {
            const allData = await Promise.all(files.map(getContents))
            const filteredData = allData.filter((data) => data != null) as {
                relativeFilePath: string
                fileContents: string
                fileHash: string
            }[]

            const hashes = filteredData.map((data) => data.fileHash)
            const fileNames = filteredData.map((data) => data.relativeFilePath)

            if (fileSystem.isRemote || !store.get('uploadPreferences')) return
            const response = await fetch(
                `${this.apiRoute}/upload/repos/private/uuids/${repoId}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Cookie: `repo_path=${this.rootDir}`,
                    },
                    body: JSON.stringify(fileNames),
                }
            )
            const foundHashes = (await response.json()) as string[]

            futures = []
            for (let i = 0; i < hashes.length; i++) {
                if (!foundHashes[i]) {
                    futures.push(uploadFile(filteredData[i]))
                } else if (foundHashes[i] != hashes[i]) {
                    futures.push(updateFile(filteredData[i]))
                }
            }
            await Promise.all(futures)
        }

        const getContents = async (file: string) => {
            const relativeFilePath = './' + path.relative(this.rootDir, file)

            let fileContents = ''
            try {
                fileContents = await fileSystem.readFileSync(file, 'utf8')
            } catch {
                return
            }
            const fileHash = crypto
                .createHash('md5')
                .update(relativeFilePath + fileContents + repoId, 'utf8')
                .digest('hex')
            return { relativeFilePath, fileContents, fileHash }
        }

        const updateFile = async ({
            relativeFilePath,
            fileContents,
            fileHash,
        }: {
            relativeFilePath: string
            fileContents: string
            fileHash: string
        }) => {
            // Semaphore context
            const release = await this.semaphore.acquire()
            log.info(`Updating file: ${relativeFilePath}`)

            // Upload file to
            if (!fileSystem.isRemote && store.get('uploadPreferences')) {
                await fetch(
                    `${this.apiRoute}/upload/repos/private/update_file/${repoId}`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Cookie: `repo_path=${this.rootDir}`,
                        },
                        body: JSON.stringify({
                            file: relativeFilePath,
                            contents: fileContents,
                        }),
                    }
                )
            }
            // Probably could be a race here
            release()
        }
        const uploadFile = async ({
            relativeFilePath,
            fileContents,
            fileHash,
        }: {
            relativeFilePath: string
            fileContents: string
            fileHash: string
        }) => {
            // Semaphore context
            const release = await this.semaphore.acquire()

            const startTime = performance.now()

            if (!fileSystem.isRemote && store.get('uploadPreferences')) {
                await fetch(
                    `${this.apiRoute}/upload/repos/private/add_file/${repoId}`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Cookie: `repo_path=${this.rootDir}`,
                        },
                        body: JSON.stringify({
                            file: relativeFilePath,
                            contents: fileContents,
                        }),
                    }
                )
            }

            // Probably could be a race here
            release()
        }

        let futures: Promise<void>[] = []
        for (let i = 0; i < files.length; i += 100) {
            futures.push(uploadFilesBatch(files.slice(i, i + 100)))
        }

        await Promise.all(futures)
    }

    async uploadFiles(files: string[], repoId: string) {
        this.repoId = repoId
        this.numFiles = files.length
        this.filesUploaded = 0
        this.finishedUpload = false
        if (fileSystem.isRemote || !store.get('uploadPreferences')) {
            this.finishedUpload = true
            return
        }
        const uploadFile = async (file: string) => {
            // Semaphore context
            const release = await this.semaphore.acquire()
            //here
            let fileContents = ''
            try {
                // Get file contents
                fileContents = await new Promise(async (resolve) => {
                    return await fileSystem.readFile(file, (err, data) => {
                        if (data == null) return null
                        return resolve(data.toString())
                    })
                })
            } catch {
                return
            }
            if (fileContents == null) return

            const relativeFilePath = './' + path.relative(this.rootDir, file)
            //here

            log.info(`Uploading file: ${relativeFilePath}`)

            // Upload file to
            if (!fileSystem.isRemote && store.get('uploadPreferences')) {
                await fetch(
                    `${this.apiRoute}/upload/repos/private/add_file/${repoId}`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Cookie: `repo_path=${this.rootDir}`,
                        },
                        body: JSON.stringify({
                            file: relativeFilePath,
                            contents: fileContents,
                        }),
                    }
                )
            }
            log.info(`Uploaded file: ${relativeFilePath}`)
            // Probably could be a race here
            this.filesUploaded += 1
            release()
        }
        const futures: Promise<void>[] = []
        for (const file of files) {
            futures.push(uploadFile(file))
        }

        await Promise.all(futures)
        this.finishedUpload = true
    }
    uploadProgress() {
        if (this.numFiles === 0) {
            return 0
        } else {
            return this.filesUploaded / (this.numFiles + 1)
        }
    }
    async syncWithServer(apiRoot: string, files: string[], repoId: string) {
        await this.updateFilesIfNeeded(files, repoId)
        //
    }
    async reIndex() {
        if (fileSystem.isRemote || !store.get('uploadPreferences')) return
        await fetch(
            `${this.apiRoute}/upload/repos/private/finish_upload/${this.repoId}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Cookie: `repo_path=${this.rootDir}`,
                },
            }
        )
    }

    async startUpdateLoop(
        apiRoot: string,
        files: string[],
        repoId: string,
        onStart = false
    ) {
        // //
        // if (onStart) {
        //     try {
        //         //
        //         await this.uploadFiles(files, repoId)
        //         // await this.syncWithServer(apiRoot, files, repoId);
        //     } catch (e) {
        //
        //     }
        // }
        // //
        // setInterval(() => {
        //     //
        //     this.syncWithServer(apiRoot, files, repoId)
        // }, 1000 * 2 * 60)
        // setInterval(() => {
        //     //
        //     this.reIndex()
        // }, 1000 * 60 * 60)
        // //
    }
}

function getSettings(rootDir: string) {
    const settings = (store.get('settingsFile' + rootDir) || {
        repoId: null,
        uploaded: false,
    }) as {
        repoId: string | null
        uploaded: boolean
    }
    return settings
}

function setSettings(
    rootDir: string,
    settings: { repoId: string | null; uploaded: boolean }
) {
    store.set('settingsFile' + rootDir, settings)
}

export function setupIndex(apiRoot: string, win: BrowserWindow) {
    const indexers = new Map<string, CodebaseIndexer>()

    ipcMain.handle(
        'syncProject',
        async function (event: IpcMainInvokeEvent, rootDir: string) {
            // const settings = getSettings(rootDir)
            // if (settings.repoId == null) return null

            // const indexer = indexers.get(settings.repoId)!
            const indexer = new CodebaseIndexer(rootDir, apiRoot, win)
            // let files = await indexer.listFiles()
            indexer.startWatcher()
            // indexer.startUpdateLoop(apiRoot, files, settings.repoId)
        }
    )

    ipcMain.handle(
        'indexProject',
        async function (event: IpcMainInvokeEvent, rootDir: string) {
            // const connectedToInternet = await fetch(`${apiRoot}/`, {
            //     method: 'GET',
            // })
            //     .then((resp) => 'SUCCESS')
            //     .catch((failure) => 'FAILURE')

            // if (connectedToInternet == 'FAILURE') {
            //     return null
            // }

            const indexer = new CodebaseIndexer(rootDir, apiRoot, win)
            // let files = await indexer.listFiles()

            // const res = await fetch(`${apiRoot}/upload/repos/private`, {
            //     method: 'POST',
            //     headers: {
            //         'Content-Type': 'application/json',
            //         Cookie: `repo_path=${indexer.rootDir}`,
            //     },
            // })
            // const response = (await res.json()) as {
            //     message: string
            //     id: string
            // }

            // const repoId = response.id

            // indexers.set(repoId, indexer)
            indexer.startWatcher()
            // await indexer.startUpdateLoop(apiRoot, files, repoId, true)
            // // await indexer.reIndex()
            // setSettings(rootDir, { repoId, uploaded: true })
            return '123'
        }
    )
    ipcMain.handle(
        'initProject',
        async function (event: IpcMainInvokeEvent, rootDir: string) {
            // log.warn('INITIALIZING PROJECT')
            // const connectedToInternet = await fetch(`${apiRoot}/`, {
            //     method: 'GET',
            // })
            //     .then((resp) => 'SUCCESS')
            //     .catch((failure) => 'FAILURE')

            // if (connectedToInternet == 'FAILURE') {
            //     return null
            // }

            // const cookie = { url: apiRoot, name: 'repo_path', value: rootDir }
            // session.defaultSession.cookies
            //     .set(cookie)
            //     .then(() => {})
            //     .catch((error) =>
            // const settings = getSettings(rootDir)
            // if (!settings.uploaded) {
            //     return null
            // } else if (settings.repoId != null) {
            //     let remoteStatus = await checkStatus(
            //         settings.repoId,
            //         apiRoot,
            //         rootDir
            //     )
            //
            //     if (remoteStatus === 'notFound' || remoteStatus === 'error') {
            //
            //         setSettings(rootDir, { repoId: null, uploaded: false })
            //         return null
            //     }

            //     log.warn('RETURNING REPO ID FOR SETTINGS')
            //     // If we have an indexer saved, return that
            //     // Otherwise, we create a new one that will be used for the next sync
            //     // We don't do the initial bulk upload though since that is taken care of
            //     let indexer =
            //         indexers.get(settings.repoId) ||
            //         new CodebaseIndexer(rootDir, apiRoot, win, settings.repoId)

            //     indexers.set(settings.repoId, indexer)
            //     indexer.finishedUpload = true
            //     log.info('GOT REPO ID', settings.repoId)
            //     return settings.repoId
            // }
            return '123'
        }
    )

    ipcMain.handle(
        'checkRepoStatus',
        async function (
            event: IpcMainInvokeEvent,
            repoId: string,
            rootDir: string
        ) {
            // return await checkStatus(repoId, apiRoot, rootDir)
        }
    )
    ipcMain.handle(
        'getProgress',
        async function (event: IpcMainInvokeEvent, repoId: string) {
            return {
                progress: 1,
                state: 'done',
            }
            // const indexer = indexers.get(repoId)
            // if (!indexer) {
            //     return {
            //         progress: 0,
            //         state: 'notStarted',
            //     }
            // }
            // if (!indexer.finishedUpload) {
            //     return {
            //         progress: indexer.uploadProgress(),
            //         state: 'uploading',
            //     }
            // }
            // if (indexer && indexer.finishedUpload) {
            //     let response = await fetch(
            //         `${apiRoot}/upload/repos/private/index_progress/${repoId}`,
            //         {
            //             method: 'GET',
            //         }
            //     )
            //     let { progress } = (await response.json()) as {
            //         progress: string
            //     }

            //     if (progress == 'done') {
            //         return {
            //             progress: 1,
            //             state: 'done',
            //         }
            //     } else {
            //         return {
            //             progress: parseFloat(progress),
            //             state: 'indexing',
            //         }
            //     }
            // }
        }
    )
}
