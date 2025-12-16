import EntryPointArtifact from '@account-abstraction/contracts/artifacts/EntryPoint.json'
import {
  getAddress,
  getContract,
  maxUint256,
  parseEther,
  zeroAddress,
  type Address,
  type Chain,
  type GetContractReturnType,
  type PublicClient,
  type ReadContractReturnType,
  type Transport,
  type WalletClient
} from 'viem'

import CrossChainPaymasterArtifact from '../../artifacts/src/CrossChainPaymaster.sol/CrossChainPaymaster.json'
import OriginSwapManagerArtifact from '../../artifacts/src/origin/OriginSwapManager.sol/OriginSwapManager.json'
import { getDeployer, getNetwork } from '../util/network.ts'
import { erc4337Fixture } from './erc4337.ts'

// Contract type declarations
export type OriginSwapManagerContractType = GetContractReturnType<
  typeof OriginSwapManagerArtifact.abi,
  PublicClient<Transport, Chain>
>

export type CrossChainPaymasterContractType = GetContractReturnType<
  typeof CrossChainPaymasterArtifact.abi,
  PublicClient<Transport, Chain>
>

export type EntryPointContractType = GetContractReturnType<
  typeof EntryPointArtifact.abi,
  PublicClient<Transport, Chain>
>

// Type for getAtomicSwapMetadata return value
// Use ReadContractReturnType to extract return type directly from ABI
export type AtomicSwapMetadataReturnType = ReadContractReturnType<
  typeof OriginSwapManagerArtifact.abi,
  'getAtomicSwapMetadata'
> & { core: { status: number; voucherIssuerL2XlpAddress: `0x${string}` } }

// Type for getIncomingAtomicSwap return value
export type AtomicSwapMetadataDestinationReturnType = ReadContractReturnType<
  typeof CrossChainPaymasterArtifact.abi,
  'getIncomingAtomicSwap'
>

// Type for tokenBalanceOf return value
export type TokenBalanceReturnType = ReadContractReturnType<
  typeof CrossChainPaymasterArtifact.abi,
  'tokenBalanceOf'
>

// Type definitions for voucher request structures
export type DestinationVoucherRequestsData = {
  vouchersAssetsMinimums: Array<
    Array<{ erc20Token: `0x${string}`; amount: bigint }>
  >
  ephemeralSigner: `0x${string}`
}

export type SessionData = {
  data: `0x${string}`
  ephemeralSignature: `0x${string}`
}

export type AtomicSwapVoucher = {
  requestId: `0x${string}`
  originationXlpAddress: `0x${string}`
  voucherRequestDest: {
    chainId: bigint
    paymaster: `0x${string}`
    sender: `0x${string}`
    assets: Array<{ erc20Token: `0x${string}`; amount: bigint }>
    maxUserOpCost: bigint
    expiresAt: bigint
  }
  expiresAt: bigint
  voucherType: number
  xlpSignature: `0x${string}`
}

export type AtomicSwapVoucherRequest = {
  origination: {
    chainId: bigint
    paymaster: `0x${string}`
    sender: `0x${string}`
    assets: Array<{ erc20Token: `0x${string}`; amount: bigint }>
    feeRule: {
      startFeePercentNumerator: bigint
      maxFeePercentNumerator: bigint
      feeIncreasePerSecond: bigint
      unspentVoucherFee: bigint
    }
    senderNonce: bigint
    allowedXlps: `0x${string}`[]
  }
  destination: {
    chainId: bigint
    paymaster: `0x${string}`
    sender: `0x${string}`
    assets: Array<{ erc20Token: `0x${string}`; amount: bigint }>
    maxUserOpCost: bigint
    expiresAt: bigint
  }
}

export type XlpEntry = {
  l1XlpAddress: `0x${string}`
  l2XlpAddress: `0x${string}`
}

export type PackedUserOperation = {
  sender: `0x${string}`
  nonce: bigint
  initCode: `0x${string}`
  callData: `0x${string}`
  accountGasLimits: `0x${string}`
  preVerificationGas: bigint
  gasFees: `0x${string}`
  paymasterAndData: `0x${string}`
  signature: `0x${string}`
}

export interface EilFixtureOptions {
  // Dispute period delay (default 1 hour)
  voucherUnlockDelay?: bigint
  // Time before dispute expires (default 7 days)
  timeBeforeDisputeExpires?: bigint
  // User cancellation delay (default 5 minutes)
  userCancellationDelay?: bigint
  // Voucher minimum expiration time (default 1 minute)
  voucherMinExpirationTime?: bigint
  // Whether to disable L2 Connector (default true, allows direct XLP registration in test environment)
  disableL2Connector?: boolean
}

export async function createEilFixture(options: EilFixtureOptions = {}) {
  const {
    voucherUnlockDelay = 3600n, // 1 hour
    timeBeforeDisputeExpires = 604800n, // 7 days
    userCancellationDelay = 300n, // 5 minutes
    voucherMinExpirationTime = 60n, // 1 minute
    disableL2Connector = true // Allow direct XLP registration
  } = options

  const { viem, networkHelpers } = await getNetwork()
  const deployer = await getDeployer()
  const deployConfig = {
    client: {
      wallet: deployer
    }
  }
  const { entryPoint } = await networkHelpers.loadFixture(erc4337Fixture)

  // Deploy OriginSwapManager (used for delegate calls)
  const originSwapManager = await viem.deployContract(
    'OriginSwapManager',
    [
      voucherUnlockDelay,
      timeBeforeDisputeExpires,
      userCancellationDelay,
      voucherMinExpirationTime,
      0n, // uint256 _disputeBondPercent
      parseEther('0.1'), // uint256 _flatNativeBond
      zeroAddress, // address originModule
      0n // uint256 l1DisputeGasLimit
    ],
    deployConfig
  )

  // Deploy Mock Bridge Connectors
  const arbInboxMock = await viem.deployContract(
    'MockArbInbox',
    [],
    deployConfig
  )
  const arbOutboxMock = await viem.deployContract(
    'MockArbOutbox',
    [],
    deployConfig
  )
  const l1ArbConnector = await viem.deployContract(
    'L1ArbitrumBridgeConnector',
    [arbOutboxMock.address, arbInboxMock.address],
    deployConfig
  )
  const l2ArbConnector = await viem.deployContract(
    'L2ArbitrumBridgeConnector',
    [],
    deployConfig
  )

  // Deploy L1AtomicSwapStakeManager
  const l1StakeManager = await viem.deployContract(
    'L1AtomicSwapStakeManager',
    [
      {
        claimDelay: 1n,
        destBeforeOriginMinGap: 1n,
        minStakePerChain: 1n,
        unstakeDelay: 1n,
        maxChainsPerXlp: maxUint256,
        l2SlashedGasLimit: 0n,
        l2StakedGasLimit: 0n,
        owner: deployer.account.address
      }
    ],
    deployConfig
  )

  // Deploy CrossChainPaymaster
  // Note: When l2Connector is set to zeroAddress, _requireFromL1StakeManager check is skipped.
  // This allows us to call onL1XlpChainInfoAdded directly in test environment.
  const crossChainPaymaster = await viem.deployContract(
    'CrossChainPaymaster',
    [
      entryPoint.address, // IEntryPoint _entryPoint
      disableL2Connector ? zeroAddress : l2ArbConnector.address, // address _l2Connector
      l1ArbConnector.address, // address _l1Connector
      l1StakeManager.address, // address _l1StakeManager
      0n, // uint256 _postOpGasCost
      0n, // uint256 _destinationL1SlashGasLimit
      zeroAddress, // address _destinationDisputeModule
      originSwapManager.address, // address _originSwapModule
      deployer.account.address // address _owner
    ],
    deployConfig
  )

  /**
   * Get a CrossChainPaymaster contract reference with OriginSwapManager ABI.
   * This is needed because CrossChainPaymaster delegates calls to OriginSwapManager via Proxy.
   */
  const getPaymasterWithOriginAbi = (
    client: PublicClient | WalletClient
  ): OriginSwapManagerContractType => {
    return getContract({
      address: crossChainPaymaster.address as Address,
      abi: OriginSwapManagerArtifact.abi,
      client
    })
  }

  /**
   * Get a CrossChainPaymaster contract reference with CrossChainPaymaster ABI.
   * This provides access to destination swap functionality directly implemented by CrossChainPaymaster.
   */
  const getPaymasterWithDestinationAbi = (
    client: PublicClient | WalletClient
  ): CrossChainPaymasterContractType => {
    return getContract({
      address: crossChainPaymaster.address as Address,
      abi: CrossChainPaymasterArtifact.abi,
      client
    })
  }

  return {
    entryPoint,
    crossChainPaymaster,
    l1StakeManager,
    l1ArbConnector,
    l2ArbConnector,
    originSwapManager,
    arbInboxMock,
    arbOutboxMock,
    getPaymasterWithOriginAbi,
    getPaymasterWithDestinationAbi
  }
}

// Default fixture (uses realistic time params by default)
export async function eilFixture() {
  return createEilFixture()
}

export async function loadEilFixture() {
  const { networkHelpers } = await getNetwork()
  return networkHelpers.loadFixture(eilFixture)
}
