import assert from 'node:assert'
import { describe, it } from 'node:test'

import { isAddress } from 'viem'

import { getDualNetworks, getNetwork } from '../util/network.ts'

describe('Cross-Chain E2E (Dual Devnet) Fixture', () => {
  it('should connect to both forked networks', async () => {
    // Get connections to both networks
    const { mainnet, arbitrum } = await getDualNetworks()

    // Get public clients for both chains
    const mainnetPublicClient = await mainnet.viem.getPublicClient()
    const arbitrumPublicClient = await arbitrum.viem.getPublicClient()

    // Verify chain IDs
    assert.equal(await mainnetPublicClient.getChainId(), 1, 'Should be mainnet')
    assert.equal(
      await arbitrumPublicClient.getChainId(),
      42161,
      'Should be Arbitrum'
    )

    // Get connection from cached map
    const arbitrumCachedConnection = await getNetwork('arbitrumMock')
    const arbitrumCachedPublicClient =
      await arbitrumCachedConnection.viem.getPublicClient()
    assert.equal(
      await arbitrumCachedPublicClient.getChainId(),
      42161,
      'Should be Arbitrum'
    )

    const mainnetCachedConnection = await getNetwork('mainnetMock')
    const mainnetCachedPublicClient =
      await mainnetCachedConnection.viem.getPublicClient()
    assert.equal(
      await mainnetCachedPublicClient.getChainId(),
      1,
      'Should be mainnet'
    )
  })

  it('should deploy contracts on both networks', async () => {
    const { mainnet, arbitrum } = await getDualNetworks()

    // Deploy a test contract on mainnet and arbitrum mocks
    const mainnetTestToken = await mainnet.viem.deployContract('TestERC20', [
      'Test Token',
      'TEST',
      18
    ])
    const arbitrumTestToken = await arbitrum.viem.deployContract('TestERC20', [
      'Test Token',
      'TEST',
      18
    ])
    assert.ok(isAddress(mainnetTestToken.address))
    assert.ok(isAddress(arbitrumTestToken.address))

    // Get connection from cached map and prevent duplicate deployment
    const arbitrumCachedConnection = await getNetwork('arbitrumMock')
    const mainnetCachedConnection = await getNetwork('mainnetMock')
    const mainnetTestTokenCached =
      await mainnetCachedConnection.viem.deployContract('TestERC20', [
        'Test Token',
        'TEST',
        18
      ])
    const arbitrumTestTokenCached =
      await arbitrumCachedConnection.viem.deployContract('TestERC20', [
        'Test Token',
        'TEST',
        18
      ])
    assert.notEqual(mainnetTestTokenCached.address, mainnetTestToken.address)
    assert.notEqual(arbitrumTestTokenCached.address, arbitrumTestToken.address)
  })
})
