import hre from 'hardhat'
import { NetworkConnection } from 'hardhat/types/network'

let network: NetworkConnection | null = null

export async function getNetwork(networkName?: string) {
  if (!network) {
    network = networkName
      ? await hre.network.connect(networkName)
      : await hre.network.connect()
  }
  return network
}

export async function getDualNetworks() {
  const [mainnet, arbitrum] = await Promise.all([
    getNetwork('mainnetMock'),
    getNetwork('arbitrumMock')
  ])
  return { mainnet, arbitrum }
}

export async function getDeployer(networkName?: string) {
  const { viem } = await getNetwork(networkName)
  return (await viem.getWalletClients()).slice(-1)[0]
}
