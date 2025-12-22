import hre from 'hardhat'
import { NetworkConnection } from 'hardhat/types/network'

const networks = new Map<string, NetworkConnection>()

export async function getNetwork(networkName?: string) {
  const key = networkName ?? ''
  if (!networks.has(key)) {
    const connection = networkName
      ? await hre.network.connect(networkName)
      : await hre.network.connect()
    networks.set(key, connection)
  }
  return networks.get(key)!
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

export async function getWalletClient(networkName?: string, index?: number) {
  const { viem } = await getNetwork(networkName)
  return (await viem.getWalletClients()).slice(index ?? 0)[0]
}
