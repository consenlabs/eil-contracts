import assert from 'node:assert'
import { describe, it } from 'node:test'

import { isAddress } from 'viem'

import { getDualNetworks } from '../util/network.ts'

describe('Cross-Chain E2E (Dual Devnet) Fixture', () => {
  it('should connect to both forked networks', async () => {
    // Get connections to both networks
    const { mainnet, arbitrum } = await getDualNetworks()

    // Get public clients for both chains
    const mainnetPublicClient = await mainnet.viem.getPublicClient()
    const arbitrumPublicClient = await arbitrum.viem.getPublicClient()

    // Verify chain IDs
    const mainnetChainId = await mainnetPublicClient.getChainId()
    const arbitrumChainId = await arbitrumPublicClient.getChainId()

    console.log('Mainnet Chain ID:', mainnetChainId)
    console.log('Arbitrum Chain ID:', arbitrumChainId)

    assert.equal(mainnetChainId, 1, 'Should be mainnet')
    assert.equal(arbitrumChainId, 42161, 'Should be Arbitrum')
  })

  it('should get wallets from both networks', async () => {
    const { mainnet, arbitrum } = await getDualNetworks()

    // Get wallet clients for both chains
    const mainnetWallets = await mainnet.viem.getWalletClients()
    const arbitrumWallets = await arbitrum.viem.getWalletClients()

    console.log('Mainnet wallet:', mainnetWallets[0].account.address)
    console.log('Arbitrum wallet:', arbitrumWallets[0].account.address)

    // Both should have wallets available
    assert.ok(mainnetWallets.length > 0, 'Should have mainnet wallets')
    assert.ok(arbitrumWallets.length > 0, 'Should have arbitrum wallets')
  })

  it('should deploy contracts on both networks', async () => {
    const { mainnet, arbitrum } = await getDualNetworks()

    // Deploy a test contract on mainnet fork
    const mainnetTestToken = await mainnet.viem.deployContract('TestERC20', [
      'Test Token',
      'TEST',
      18
    ])
    console.log('TestToken on Mainnet:', mainnetTestToken.address)

    // Deploy a test contract on arbitrum fork
    const arbitrumTestToken = await arbitrum.viem.deployContract('TestERC20', [
      'Test Token',
      'TEST',
      18
    ])
    console.log('TestToken on Arbitrum:', arbitrumTestToken.address)

    assert.ok(isAddress(mainnetTestToken.address))
    assert.ok(isAddress(arbitrumTestToken.address))
  })
})
