import assert from 'node:assert/strict'
import {test} from 'node:test'

import {canFormat, canMount, canUnmount, formatConfirmToken, formatPhraseMatches} from '../web/src/storageTools.ts'

const disk = (over) => ({path: '/dev/sdb', name: 'sdb', model: 'SanDisk Ultra', serial: 'AA11BB22', role: 'data', mounted: false, pool: null, ...over})

test('formatConfirmToken prefers model, then last 4 of serial, then kernel name', () => {
	assert.equal(formatConfirmToken(disk({})), 'SanDisk Ultra')
	assert.equal(formatConfirmToken(disk({model: '  '})), 'BB22')
	assert.equal(formatConfirmToken(disk({model: null, serial: null})), 'sdb')
})

test('formatPhraseMatches is case-insensitive and trimmed', () => {
	assert.equal(formatPhraseMatches(disk({}), 'SanDisk Ultra'), true)
	assert.equal(formatPhraseMatches(disk({}), '  sandisk ultra  '), true)
	assert.equal(formatPhraseMatches(disk({}), 'sdb'), false)
})

test('canFormat only for unmounted non-system non-pool disks', () => {
	assert.equal(canFormat(disk({})), true)
	assert.equal(canFormat(disk({role: 'blank'})), true)
	assert.equal(canFormat(disk({role: 'system'})), false)
	assert.equal(canFormat(disk({role: 'pool', pool: 'media'})), false)
	assert.equal(canFormat(disk({mounted: true})), false)
})

test('canUnmount only for mounted non-system non-pool disks', () => {
	assert.equal(canUnmount(disk({mounted: true})), true)
	assert.equal(canUnmount(disk({mounted: false})), false)
	assert.equal(canUnmount(disk({mounted: true, role: 'system'})), false)
	assert.equal(canUnmount(disk({mounted: true, role: 'pool'})), false)
})

test('canMount only for unmounted data disks that already have a filesystem', () => {
	assert.equal(canMount(disk({})), true)
	assert.equal(canMount(disk({role: 'blank'})), false)
	assert.equal(canMount(disk({role: 'system'})), false)
	assert.equal(canMount(disk({role: 'pool', pool: 'media'})), false)
	assert.equal(canMount(disk({mounted: true})), false)
})
