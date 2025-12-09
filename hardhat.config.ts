import hardhatNetworkHelpers from '@nomicfoundation/hardhat-network-helpers'
import hardhatNodeTestRunner from '@nomicfoundation/hardhat-node-test-runner'
import hardhatViem from '@nomicfoundation/hardhat-viem'
import hardhatViemAssertions from '@nomicfoundation/hardhat-viem-assertions'
import { HardhatUserConfig } from 'hardhat/config'

const config: HardhatUserConfig = {
  plugins: [
    hardhatViem,
    hardhatViemAssertions,
    hardhatNetworkHelpers,
    hardhatNodeTestRunner
  ],
  solidity: {
    compilers: [
      {
        version: '0.8.28',
        settings: {
          evmVersion: 'cancun',
          optimizer: { enabled: true, runs: 1000000 },
          viaIR: true
        }
      }
    ]
  },
  paths: {
    sources: './src/'
  },
  networks: {
    // Background devnet nodes (run with: npx hardhat node --network <network-name> --port <port>)
    mainnetMock: {
      type: 'edr-simulated',
      chainId: 1
    },
    arbitrumMock: {
      type: 'edr-simulated',
      chainId: 42161
    }
  }
}

export default config
