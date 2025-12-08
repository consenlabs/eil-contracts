import assert from 'node:assert'
import { describe, it } from 'node:test'

import { concat, getAddress, isAddress, keccak256 } from 'viem'

import { loadEilFixture } from './fixture/eil.ts'
import { loadErc4337Fixture } from './fixture/erc4337.ts'
import { loadSimpleMultiChainAccountFixture } from './fixture/simpleMultiChainAccount.ts'
import { getDeployer } from './util/network.ts'

describe('Fixture', () => {
  it('should load ERC-4337 fixture', async () => {
    const { entryPoint } = await loadErc4337Fixture()
    assert.equal(isAddress(entryPoint.address), true)
  })

  it('should load EIL fixture', async () => {
    const eilContract = await loadEilFixture()
    for (const contract of Object.values(eilContract)) {
      assert.equal(isAddress(contract.address), true)
    }
  })

  it('should load Simple Multi Chain Account fixture', async () => {
    const { simpleMultiChainAccount, simpleMultiChainAccountFactory } =
      await loadSimpleMultiChainAccountFixture()
    assert.equal(isAddress(simpleMultiChainAccount.address), true)
    assert.equal(isAddress(simpleMultiChainAccountFactory.address), true)

    const deployer = await getDeployer()
    assert.equal(
      simpleMultiChainAccount.address,
      await simpleMultiChainAccountFactory.read.getAddress([
        deployer.account.address,
        0n
      ])
    )
    assert.equal(
      getAddress(deployer.account.address),
      await simpleMultiChainAccount.read.owner()
    )

    const hashes = [keccak256('0xabc'), keccak256('0xdef'), keccak256('0xghi')]
    const signature = concat(hashes)
    assert.equal(
      await simpleMultiChainAccount.read.isValidSignature([
        hashes[1],
        signature
      ]),
      true
    )
    assert.equal(
      await simpleMultiChainAccount.read.isValidSignature([
        keccak256('0xjkl'),
        signature
      ]),
      false
    )
  })
})
