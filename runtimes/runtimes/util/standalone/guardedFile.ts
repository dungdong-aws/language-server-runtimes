import { constants } from 'fs'
import { open, FileHandle } from 'fs/promises'
import { Logging } from '../../../server-interface/logging'

type DebugLogger = Pick<Logging, 'debug'>

export function logFileAccess(
    logging: DebugLogger | undefined,
    event: string,
    targetPath: string,
    fd?: number,
    error?: unknown
): void {
    try {
        logging?.debug(
            `[file-access] ${JSON.stringify({
                event,
                targetPath,
                fd,
                ...(error instanceof Error
                    ? { errorName: error.name, errorCode: (error as NodeJS.ErrnoException).code }
                    : {}),
            })}`
        )
    } catch {
        // Diagnostics must not change file-operation results.
    }
}

async function closeFile(handle: FileHandle, path: string, logging?: DebugLogger, operationFailed = false) {
    const fd = handle.fd
    try {
        await handle.close()
        logFileAccess(logging, 'handle.closed', path, fd)
    } catch (error) {
        logFileAccess(logging, 'handle.closeFailed', path, fd, error)
        if (!operationFailed) throw error
    }
}

async function openRegularFile(path: string, flags: number, logging?: DebugLogger): Promise<FileHandle> {
    let handle: FileHandle
    try {
        if (process.platform === 'win32' || !constants.O_NOFOLLOW) {
            throw Object.assign(new Error('This file operation is unavailable on this platform'), { code: 'ENOTSUP' })
        }
        handle = await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (error) {
        logFileAccess(logging, 'open.failed', path, undefined, error)
        throw error
    }
    logFileAccess(logging, 'open.completed', path, handle.fd)
    try {
        const stat = await handle.stat()
        if (!stat.isFile()) {
            throw Object.assign(new Error('Expected a regular file'), {
                code: stat.isDirectory() ? 'EISDIR' : 'EINVAL',
            })
        }
        logFileAccess(logging, 'handle.checked', path, handle.fd)
        return handle
    } catch (error) {
        await closeFile(handle, path, logging, true)
        throw error
    }
}

export async function readFileNoFollow(path: string, logging?: DebugLogger): Promise<string> {
    const handle = await openRegularFile(path, constants.O_RDONLY, logging)
    let failed = false
    try {
        const content = await handle.readFile({ encoding: 'utf8' })
        logFileAccess(logging, 'read.completed', path, handle.fd)
        return content
    } catch (error) {
        failed = true
        logFileAccess(logging, 'read.failed', path, handle.fd, error)
        throw error
    } finally {
        await closeFile(handle, path, logging, failed)
    }
}

export async function updateFileNoFollow(
    path: string,
    transform: (content: string) => string,
    options: { create?: boolean; readExisting?: boolean } = {},
    logging?: DebugLogger
): Promise<void> {
    let handle: FileHandle
    try {
        handle = await openRegularFile(
            path,
            options.readExisting === false ? constants.O_WRONLY : constants.O_RDWR,
            logging
        )
    } catch (error) {
        if (!options.create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        handle = await openRegularFile(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, logging)
    }
    let failed = false
    try {
        const previous = options.readExisting === false ? '' : await handle.readFile({ encoding: 'utf8' })
        const content = Buffer.from(transform(previous), 'utf8')
        // Reading advances the handle offset; replacement writes use explicit positions.
        let offset = 0
        while (offset < content.length) {
            const { bytesWritten } = await handle.write(content, offset, content.length - offset, offset)
            if (bytesWritten === 0) throw new Error('File write made no progress')
            offset += bytesWritten
        }
        await handle.truncate(content.length)
        logFileAccess(logging, 'update.completed', path, handle.fd)
    } catch (error) {
        failed = true
        logFileAccess(logging, 'update.failed', path, handle.fd, error)
        throw error
    } finally {
        await closeFile(handle, path, logging, failed)
    }
}
