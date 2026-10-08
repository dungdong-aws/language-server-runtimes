/** Identity and link count observed together for an existing regular file. */
export type ExistingFileTarget = Readonly<{
    path: string
    state: 'existing'
    dev: string
    ino: string
    linkCount: string
}>

/** Capture before acceptance; retain this value for the subsequent operation. */
export type CheckedFileTarget = ExistingFileTarget | Readonly<{ path: string; state: 'missing' }>

export type FileUpdateOutcome = Readonly<{
    /** True after creation or a mutation attempt, including an indeterminate failure. */
    mayHaveChanged: boolean
    /** True only when the replacement and handle close both completed. Not a durability guarantee. */
    complete: boolean
    /** Obtained from the opened handle, never by looking up the path after writing. */
    target?: ExistingFileTarget
}>

export class FileUpdateError extends Error {
    readonly code?: string

    constructor(
        public readonly cause: unknown,
        public readonly outcome: FileUpdateOutcome
    ) {
        super(cause instanceof Error ? cause.message : String(cause))
        this.name = 'FileUpdateError'
        this.code = (cause as NodeJS.ErrnoException | undefined)?.code
    }
}

/** Optional POSIX regular-file operations. Consumers must check the version before use. */
export interface CheckedFileOperations {
    readonly version: 1
    /** Observe a canonical path without following a final symbolic link. */
    capture(path: string): Promise<CheckedFileTarget>
    /** Read through a handle matching the captured identity and link-count bound. */
    read(target: CheckedFileTarget): Promise<string>
    /**
     * Transform and replace through one verified handle. Missing targets require create=true
     * and use exclusive creation; existing targets are never recreated if removed.
     * A FileUpdateError reports the outcome when an update fails.
     */
    update(
        target: CheckedFileTarget,
        transform: (content: string) => string,
        options?: { create?: boolean; readExisting?: boolean }
    ): Promise<FileUpdateOutcome>
}
