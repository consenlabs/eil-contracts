import EntryPointArtifact from '@account-abstraction/contracts/artifacts/EntryPoint.json'
import { getContract } from 'viem'

import { getDeployer, getNetwork } from '../util/network.ts'

export async function createErc4337Fixture(networkName?: string) {
  const { viem } = await getNetwork(networkName)
  const deployer = await getDeployer(networkName)

  const hash = await deployer.deployContract({
    abi: EntryPointArtifact.abi,
    bytecode: EntryPointArtifact.bytecode as `0x${string}`
  })
  const receipt = await (
    await viem.getPublicClient()
  ).waitForTransactionReceipt({ hash })

  const entryPoint = getContract({
    address: receipt.contractAddress as `0x${string}`,
    abi: EntryPointArtifact.abi,
    client: deployer
  })
  return { entryPoint }
}

// Default fixture (uses realistic time params by default)
export async function erc4337Fixture() {
  return createErc4337Fixture()
}

export async function loadErc4337Fixture(networkName?: string) {
  const { networkHelpers } = await getNetwork(networkName)
  return networkHelpers.loadFixture(erc4337Fixture)
}
