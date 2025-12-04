import { getContract } from "viem"

import SimpleMultiChainAccountArtifact from "../../artifacts/src/test/SimpleMultiChainAccount.sol/SimpleMultiChainAccount.json"
import { getDeployer, getNetwork } from "../util/network.ts"
import { erc4337Fixture } from "./erc4337.ts"

export async function simpleMultiChainAccountFixture() {
  const { viem, networkHelpers } = await getNetwork()
  const deployer = await getDeployer()
  const deployConfig = {
    client: {
      wallet: deployer
    }
  }
  const { entryPoint } = await networkHelpers.loadFixture(erc4337Fixture)
  const simpleMultiChainAccountFactory = await viem.deployContract(
    "SimpleMultiChainAccountFactory",
    [entryPoint.address],
    deployConfig
  )

  await simpleMultiChainAccountFactory.write.createAccount([
    deployer.account.address,
    0n
  ])

  const simpleMultiChainAccount = getContract({
    address: await simpleMultiChainAccountFactory.read.getAddress([
      deployer.account.address,
      0n
    ]),
    abi: SimpleMultiChainAccountArtifact.abi,
    client: deployer
  })
  return { simpleMultiChainAccount, simpleMultiChainAccountFactory }
}

export async function loadSimpleMultiChainAccountFixture() {
  const { networkHelpers } = await getNetwork()
  return networkHelpers.loadFixture(simpleMultiChainAccountFixture)
}
