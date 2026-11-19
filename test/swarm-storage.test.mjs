import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

test('connector helper.py unit tests', () => {
	execFileSync('python3', [fileURLToPath(new URL('../connector/test_helper.py', import.meta.url))], {stdio: 'inherit'})
})
