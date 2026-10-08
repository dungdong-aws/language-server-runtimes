import assert from 'assert'
import fs from 'fs/promises'
import { constants } from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as sinon from 'sinon'
import { readFileNoFollow, updateFileNoFollow } from './guardedFile'
;(process.platform !== 'win32' && constants.O_NOFOLLOW ? describe : describe.skip)('guarded file operations', () => {
    let directory: string
    let file: string

    beforeEach(async () => {
        directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'guarded-file-')))
        file = path.join(directory, 'example.txt')
        await fs.writeFile(file, 'original fixture')
    })

    afterEach(async () => {
        sinon.restore()
        await fs.rm(directory, { recursive: true, force: true })
    })

    it('reads a regular file and supports shorter, empty and multibyte replacements', async () => {
        assert.strictEqual(await readFileNoFollow(file), 'original fixture')
        for (const content of ['short', '', 'updated \u65e5\u672c']) {
            await updateFileNoFollow(file, () => content, { readExisting: false })
            assert.strictEqual(await fs.readFile(file, 'utf8'), content)
        }
    })

    it('reads and transforms through the same handle with positional replacement', async () => {
        await updateFileNoFollow(file, content => content.replace('original', 'updated'))
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'updated fixture')
    })

    it('creates missing destinations exclusively', async () => {
        const missing = path.join(directory, 'new.txt')
        await assert.rejects(
            updateFileNoFollow(missing, () => 'new'),
            { code: 'ENOENT' }
        )
        await updateFileNoFollow(missing, () => 'new', { create: true, readExisting: false })
        assert.strictEqual(await fs.readFile(missing, 'utf8'), 'new')
    })

    it('does not truncate when the transform fails', async () => {
        const failure = new Error('Transform failed')
        await assert.rejects(
            updateFileNoFollow(file, () => {
                throw failure
            }),
            error => error === failure
        )
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'original fixture')
    })

    it('rejects final links and dangling links without reading or creating their targets', async () => {
        const link = path.join(directory, 'link.txt')
        await fs.symlink(file, link)
        await assert.rejects(readFileNoFollow(link), { code: 'ELOOP' })
        await assert.rejects(
            updateFileNoFollow(link, () => 'changed', { create: true }),
            { code: 'ELOOP' }
        )
        const missing = path.join(directory, 'missing.txt')
        const dangling = path.join(directory, 'dangling.txt')
        await fs.symlink(missing, dangling)
        await assert.rejects(
            updateFileNoFollow(dangling, () => 'changed', { create: true }),
            { code: 'ELOOP' }
        )
        await assert.rejects(fs.stat(missing), { code: 'ENOENT' })
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'original fixture')
    })

    it('rejects a checked filename replaced before opening', async () => {
        const checked = await fs.realpath(file)
        const other = path.join(directory, 'other.txt')
        await fs.writeFile(other, 'untouched')
        await fs.unlink(file)
        await fs.symlink(other, file)
        await assert.rejects(readFileNoFollow(checked), { code: 'ELOOP' })
        await assert.rejects(
            updateFileNoFollow(checked, () => 'changed'),
            { code: 'ELOOP' }
        )
        assert.strictEqual(await fs.readFile(other, 'utf8'), 'untouched')
    })

    it('keeps reading and writing the opened object after the filename changes', async () => {
        const other = path.join(directory, 'other.txt')
        const moved = path.join(directory, 'moved.txt')
        await fs.writeFile(other, 'untouched')
        const original = fs.open
        sinon.stub(fs, 'open').callsFake(async (target, flags, mode) => {
            const handle = await original(target, flags, mode)
            await fs.rename(file, moved)
            await fs.symlink(other, file)
            return handle
        })
        await updateFileNoFollow(file, content => content.replace('original', 'updated'))
        assert.strictEqual(await fs.readFile(moved, 'utf8'), 'updated fixture')
        assert.strictEqual(await fs.readFile(other, 'utf8'), 'untouched')
    })

    it('does not follow a competing entry on the creation retry', async () => {
        const open = sinon.stub(fs, 'open')
        open.onFirstCall().rejects(Object.assign(new Error('missing'), { code: 'ENOENT' }))
        open.onSecondCall().rejects(Object.assign(new Error('exists'), { code: 'EEXIST' }))
        await assert.rejects(
            updateFileNoFollow(file, () => 'changed', { create: true }),
            { code: 'EEXIST' }
        )
        const flags = open.secondCall.args[1] as number
        assert.ok(flags & constants.O_CREAT)
        assert.ok(flags & constants.O_EXCL)
        assert.ok(flags & constants.O_NOFOLLOW)
        assert.strictEqual(flags & constants.O_TRUNC, 0)
    })

    it('rejects a non-regular opened object and closes it', async () => {
        const handle = await fs.open(directory, constants.O_RDONLY)
        const close = sinon.spy(handle, 'close')
        sinon.stub(fs, 'open').resolves(handle)
        await assert.rejects(readFileNoFollow(directory), { code: 'EISDIR' })
        sinon.assert.calledOnce(close)
    })

    it('preserves the read error when closing also fails', async () => {
        const handle = await fs.open(file, constants.O_RDONLY)
        const close = handle.close.bind(handle)
        const failure = new Error('Read failed')
        sinon.stub(fs, 'open').resolves(handle)
        sinon.stub(handle, 'readFile').rejects(failure)
        sinon.stub(handle, 'close').callsFake(async () => {
            await close()
            throw new Error('Close failed')
        })
        await assert.rejects(readFileNoFollow(file), error => error === failure)
    })

    it('preserves the transform error when closing also fails', async () => {
        const handle = await fs.open(file, constants.O_RDWR)
        const close = handle.close.bind(handle)
        const failure = new Error('Transform failed')
        sinon.stub(fs, 'open').resolves(handle)
        sinon.stub(handle, 'close').callsFake(async () => {
            await close()
            throw new Error('Close failed')
        })
        await assert.rejects(
            updateFileNoFollow(file, () => {
                throw failure
            }),
            error => error === failure
        )
    })

    it('preserves the handle-check error when closing also fails', async () => {
        const handle = await fs.open(file, constants.O_RDONLY)
        const close = handle.close.bind(handle)
        const failure = new Error('Stat failed')
        sinon.stub(fs, 'open').resolves(handle)
        sinon.stub(handle, 'stat').rejects(failure)
        sinon.stub(handle, 'close').callsFake(async () => {
            await close()
            throw new Error('Close failed')
        })
        await assert.rejects(readFileNoFollow(file), error => error === failure)
    })

    it('surfaces a close failure after otherwise successful I/O', async () => {
        const handle = await fs.open(file, constants.O_RDONLY)
        const close = handle.close.bind(handle)
        const failure = new Error('Close failed')
        sinon.stub(fs, 'open').resolves(handle)
        sinon.stub(handle, 'close').callsFake(async () => {
            await close()
            throw failure
        })
        await assert.rejects(readFileNoFollow(file), error => error === failure)
    })

    it('completes partial writes and rejects zero-progress writes', async () => {
        const handle = await fs.open(file, constants.O_RDWR)
        const write = handle.write.bind(handle)
        sinon.stub(fs, 'open').resolves(handle)
        const partial = sinon.stub(handle, 'write').callsFake(async (...args: any[]) => {
            const [buffer, offset, length, position] = args
            return write(buffer, offset, Math.min(length, 2), position)
        })
        await updateFileNoFollow(file, () => 'short')
        assert.ok(partial.callCount > 1)
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'short')
        sinon.restore()
        const stuck = await fs.open(file, constants.O_RDWR)
        sinon.stub(fs, 'open').resolves(stuck)
        sinon.stub(stuck, 'write').resolves({ bytesWritten: 0, buffer: '' })
        await assert.rejects(
            updateFileNoFollow(file, () => 'next'),
            /no progress/
        )
    })

    it('logs lifecycle metadata without file content and tolerates diagnostic failures', async () => {
        const debug = sinon.stub()
        await updateFileNoFollow(file, () => 'private-content', {}, { debug })
        const entries = debug.getCalls().map(call => JSON.parse(call.args[0].slice('[file-access] '.length)))
        assert.deepStrictEqual(
            entries.map(entry => entry.event),
            ['open.completed', 'handle.checked', 'update.completed', 'handle.closed']
        )
        assert.ok(!JSON.stringify(entries).includes('private-content'))
        assert.ok(!JSON.stringify(entries).includes('original fixture'))
        assert.strictEqual(
            await readFileNoFollow(file, {
                debug: () => {
                    throw new Error('Logger unavailable')
                },
            }),
            'private-content'
        )
    })
})
