import assert from 'node:assert'
import { before, describe, it } from 'node:test'

import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getContract,
  keccak256,
  pad,
  parseEther,
  toHex,
  zeroAddress
} from 'viem'

import OriginSwapManagerArtifact from '../../artifacts/src/origin/OriginSwapManager.sol/OriginSwapManager.json'
import SimpleMultiChainAccountArtifact from '../../artifacts/src/test/SimpleMultiChainAccount.sol/SimpleMultiChainAccount.json'
import TestERC20Artifact from '../../artifacts/src/test/TestERC20.sol/TestERC20.json'
import { createEilFixture } from '../fixture/eil.ts'
import { getDeployer, getNetwork } from '../util/network.ts'

// Native ETH address used by the contract (not address(0)!)
const NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as const

/**
 * EIL Cross-Chain Atomic Swap Integration Tests
 *
 * Complete flow based on the sequence diagram:
 * 1. Lookup registered & funded XLPs (Chain_A, Chain_B)
 * 2. Fill & Sign UserOps
 * 3. UserOp1: Commit funds (lock funds on origin chain)
 * 4. XLP Claim funds (gives voucher) - XLP issues voucher on origin chain
 * 5. UserOp2: Use voucher to claim funds + call (use voucher on destination chain)
 * 6. Alice gets funds
 * 7. Paymaster pays gas
 * 8. Alice's call executes
 * 9. Wait an hour
 * 10. XLP Unlock & reuse funds (XLP withdraws funds from origin chain)
 */
describe('Cross-Chain Atomic Swap Integration', () => {
  let testToken: any
  let viem: any
  let networkHelpers: any
  let publicClient: any
  let walletClients: any[]
  let deployer: any
  let deployConfig: any
  let fixture: any
  let crossChainPaymaster: any
  let entryPoint: any
  let getPaymasterWithOriginAbi: any
  let getPaymasterWithDestinationAbi: any

  // Setup shared resources for all tests
  before(async () => {
    const network = await getNetwork()
    viem = network.viem
    networkHelpers = network.networkHelpers
    publicClient = await viem.getPublicClient()
    walletClients = await viem.getWalletClients()
    deployer = await getDeployer()
    deployConfig = { client: { wallet: deployer } }

    // Deploy testToken
    testToken = await viem.deployContract(
      'TestERC20',
      ['Test Token', 'TT', 18],
      deployConfig
    )

    // Create EIL fixture (default params work for all tests)
    fixture = await createEilFixture()
    crossChainPaymaster = fixture.crossChainPaymaster
    entryPoint = fixture.entryPoint
    getPaymasterWithOriginAbi = fixture.getPaymasterWithOriginAbi
    getPaymasterWithDestinationAbi = fixture.getPaymasterWithDestinationAbi
  })

  /**
   * Complete cross-chain atomic swap flow test using SimpleMultiChainAccount.
   * Simulates Alice transferring assets from Chain_A to Chain_B via ERC-4337 UserOp.
   *
   * Note: CrossChainPaymaster delegates calls to OriginSwapManager,
   * so all origin and destination operations go through crossChainPaymaster.
   */
  it('should complete cross-chain swap with SimpleMultiChainAccount', async () => {
    const alice = walletClients[0] // User (EOA owner of SimpleMultiChainAccount)
    const xlpOperator = walletClients[1] // XLP operator

    // Deploy SimpleMultiChainAccountFactory using the same EntryPoint
    const simpleMultiChainAccountFactory = await viem.deployContract(
      'SimpleMultiChainAccountFactory',
      [entryPoint.address],
      deployConfig
    )

    // Create Alice's SimpleMultiChainAccount
    await simpleMultiChainAccountFactory.write.createAccount([
      alice.account.address,
      1n // salt = 1 for Alice
    ])
    const aliceAccountAddress =
      await simpleMultiChainAccountFactory.read.getAddress([
        alice.account.address,
        1n
      ])
    console.log('✓ Alice SimpleMultiChainAccount:', aliceAccountAddress)

    // Get paymaster reference with OriginSwapManager ABI
    const paymasterAsOrigin = getPaymasterWithOriginAbi(alice)
    const paymasterAsOriginXlp = getPaymasterWithOriginAbi(xlpOperator)

    // ========================================
    // Step 1: Lookup registered & funded XLPs
    // ========================================
    console.log('\n=== Step 1: Register XLP and fund deposits ===')

    // Register XLP (can be called directly when l2Connector is zeroAddress)
    await crossChainPaymaster.write.onL1XlpChainInfoAdded([
      xlpOperator.account.address, // l1XlpAddress
      xlpOperator.account.address // l2XlpAddress
    ])

    // Verify XLP is registered
    const isXlpRegistered = await crossChainPaymaster.read.isL2XlpRegistered([
      xlpOperator.account.address
    ])
    assert.equal(isXlpRegistered, true, 'XLP should be registered')
    console.log('✓ XLP registered:', xlpOperator.account.address)

    // XLP deposits ETH on destination chain (for paying user assets and gas)
    const xlpDepositAmount = parseEther('10')
    await crossChainPaymaster.write.depositToXlp(
      [xlpOperator.account.address],
      { value: xlpDepositAmount, account: xlpOperator.account }
    )

    // Verify XLP balance
    const xlpNativeBalance = await crossChainPaymaster.read.nativeBalanceOf([
      xlpOperator.account.address
    ])
    assert.equal(
      xlpNativeBalance,
      xlpDepositAmount,
      'XLP should have deposited ETH'
    )
    console.log('✓ XLP funded with:', xlpDepositAmount, 'wei')

    // Deposit ETH to EntryPoint for CrossChainPaymaster to pay for gas as paymaster
    const paymasterDepositAmount = parseEther('1')
    await entryPoint.write.depositTo([crossChainPaymaster.address], {
      value: paymasterDepositAmount,
      account: deployer.account
    })
    console.log(
      '✓ CrossChainPaymaster deposited to EntryPoint:',
      paymasterDepositAmount,
      'wei'
    )

    // ========================================
    // Step 2 & 3: Fill & Sign UserOps, UserOp1: Commit funds
    // ========================================
    console.log('\n=== Step 2 & 3: Alice commits funds on origin chain ===')
    const chainId = await publicClient.getChainId()
    const currentTimestamp = BigInt(await networkHelpers.time.latest())
    const aliceAccountNonce = await (
      paymasterAsOrigin as any
    ).read.getSenderNonce([aliceAccountAddress])

    const swapAmount = parseEther('1')
    const maxFeePercent = 100n
    const amountWithMaxFee = swapAmount + (swapAmount * maxFeePercent) / 10000n

    // Mint tokens directly to SimpleMultiChainAccount
    await testToken.write.sudoMint([aliceAccountAddress, amountWithMaxFee])

    // Get SimpleMultiChainAccount contract reference
    const aliceAccount = getContract({
      address: aliceAccountAddress,
      abi: SimpleMultiChainAccountArtifact.abi,
      client: alice
    })

    // Send ETH directly to SimpleMultiChainAccount for gas payment
    // Account can pay ETH at need without deposit to EntryPoint in advance
    await alice.sendTransaction({
      to: aliceAccountAddress,
      value: parseEther('1'),
      account: alice.account
    })
    console.log('✓ Sent ETH to AA account for gas payment')

    // Approve tokens via UserOp
    const approveCallData = encodeFunctionData({
      abi: TestERC20Artifact.abi,
      functionName: 'approve',
      args: [crossChainPaymaster.address, amountWithMaxFee]
    })
    const executeApproveCallData = encodeFunctionData({
      abi: SimpleMultiChainAccountArtifact.abi,
      functionName: 'execute',
      args: [testToken.address, 0n, approveCallData]
    })
    const { userOp: approveUserOp, userOpHash: approveUserOpHash } =
      await buildUserOp(aliceAccountAddress, entryPoint, executeApproveCallData)
    approveUserOp.signature = signUserOp(approveUserOpHash)
    await entryPoint.write.handleOps([[approveUserOp], alice.account.address])

    // Both origin and destination sender are SimpleMultiChainAccount
    const voucherRequest = {
      origination: {
        chainId: BigInt(chainId),
        paymaster: getAddress(crossChainPaymaster.address),
        sender: getAddress(aliceAccountAddress), // SimpleMultiChainAccount as origin sender
        assets: [
          { erc20Token: getAddress(testToken.address), amount: swapAmount }
        ],
        feeRule: {
          startFeePercentNumerator: 10n,
          maxFeePercentNumerator: maxFeePercent,
          feeIncreasePerSecond: 1n,
          unspentVoucherFee: parseEther('0.01')
        },
        senderNonce: aliceAccountNonce,
        allowedXlps: [getAddress(xlpOperator.account.address)]
      },
      destination: {
        chainId: BigInt(chainId),
        paymaster: getAddress(crossChainPaymaster.address),
        sender: getAddress(aliceAccountAddress), // SimpleMultiChainAccount as destination sender
        assets: [{ erc20Token: NATIVE_ETH, amount: parseEther('0.9') }],
        maxUserOpCost: parseEther('0.1'),
        expiresAt: currentTimestamp + 3600n
      }
    }

    const requestId = getVoucherRequestId(voucherRequest)
    console.log('✓ Request ID:', requestId)

    // ========================================
    // Step 2.5: Pre-sign UserOp1 and UserOp2 (EntryPoint v0.9 parallelizable signing)
    // ========================================
    console.log(
      '\n=== Step 2.5: Pre-sign UserOp1 and UserOp2 (before getting voucher) ==='
    )
    console.log(
      'Using EntryPoint v0.9 parallelizable Paymaster signing feature:'
    )
    console.log(
      '- userOpHash does NOT include paymasterSignature, allowing pre-signing'
    )
    console.log(
      '- User can sign UserOp before voucher is ready, then add paymasterSignature later'
    )

    // Build UserOp1: Lock user deposit (no paymaster needed)
    const lockDepositCallData = encodeFunctionData({
      abi: OriginSwapManagerArtifact.abi,
      functionName: 'lockUserDeposit',
      args: [voucherRequest]
    })
    const executeLockDepositCallData = encodeFunctionData({
      abi: SimpleMultiChainAccountArtifact.abi,
      functionName: 'execute',
      args: [crossChainPaymaster.address, 0n, lockDepositCallData]
    })
    // Get current nonce for UserOp1
    const currentNonce = await entryPoint.read.getNonce([
      aliceAccountAddress,
      0n
    ])

    const { userOp: lockUserOp, userOpHash: lockUserOpHash } =
      await buildUserOp(
        aliceAccountAddress,
        entryPoint,
        executeLockDepositCallData,
        '0x',
        currentNonce as bigint
      )

    // Build UserOp2: Use voucher (with paymaster, but WITHOUT paymasterSignature yet)
    // Build DestinationVoucherRequestsData (we know the structure even without voucher)
    const destinationVoucherRequestsData = {
      vouchersAssetsMinimums: [voucherRequest.destination.assets],
      ephemeralSigner: zeroAddress
    }

    // Pre-calculate paymasterSignature length using a placeholder voucher
    // This allows us to create a fake signature with the same length
    // Structure: AtomicSwapVoucher[] + SessionData
    // We use a placeholder voucher with a fixed-length xlpSignature (65 bytes for ECDSA)
    const placeholderVoucher = {
      requestId,
      originationXlpAddress: zeroAddress,
      voucherRequestDest: voucherRequest.destination,
      expiresAt: 0n,
      voucherType: 0,
      xlpSignature: ('0x' + '00'.repeat(65)) as `0x${string}`
    }
    const placeholderSessionData = {
      data: '0x' as `0x${string}`,
      ephemeralSignature: '0x' as `0x${string}`
    }
    const placeholderPaymasterSignature = encodeAbiParameters(
      [
        {
          type: 'tuple[]',
          components: [
            { type: 'bytes32', name: 'requestId' },
            { type: 'address', name: 'originationXlpAddress' },
            {
              type: 'tuple',
              name: 'voucherRequestDest',
              components: [
                { type: 'uint256', name: 'chainId' },
                { type: 'address', name: 'paymaster' },
                { type: 'address', name: 'sender' },
                {
                  type: 'tuple[]',
                  name: 'assets',
                  components: [
                    { type: 'address', name: 'erc20Token' },
                    { type: 'uint256', name: 'amount' }
                  ]
                },
                { type: 'uint256', name: 'maxUserOpCost' },
                { type: 'uint256', name: 'expiresAt' }
              ]
            },
            { type: 'uint256', name: 'expiresAt' },
            { type: 'uint8', name: 'voucherType' },
            { type: 'bytes', name: 'xlpSignature' }
          ]
        },
        {
          type: 'tuple',
          components: [
            { type: 'bytes', name: 'data' },
            { type: 'bytes', name: 'ephemeralSignature' }
          ]
        }
      ],
      [[placeholderVoucher], placeholderSessionData]
    )
    const fakeSignatureLength = (placeholderPaymasterSignature.length - 2) / 2 // Convert hex string length to bytes

    // Build paymasterAndData WITH fake signature (for parallelizable signing)
    // This ensures userOpHash consistency because EntryPoint's paymasterDataKeccak
    // will hash the same structure (base || signature || uint16(length) || MAGIC) in both cases
    const paymasterAndDataWithoutSig = encodePaymasterAndDataWithoutSignature(
      getAddress(crossChainPaymaster.address),
      100000n, // validationGasLimit
      50000n, // postOpGasLimit
      destinationVoucherRequestsData,
      fakeSignatureLength // Add fake signature with this length
    )

    const noOpCallData = encodeFunctionData({
      abi: SimpleMultiChainAccountArtifact.abi,
      functionName: 'execute',
      args: [aliceAccountAddress, 0n, '0x'] // No-op: call self with empty data
    })

    // Use nonce + 1 for UserOp2 (since UserOp1 will execute first)
    const { userOp: withdrawUserOp, userOpHash: withdrawUserOpHash } =
      await buildUserOp(
        aliceAccountAddress,
        entryPoint,
        noOpCallData,
        paymasterAndDataWithoutSig,
        (currentNonce as bigint) + 1n // Use next nonce for UserOp2
      )

    // Sign both UserOps with a unified signature
    const unifiedSignature = concat([
      pad(lockUserOpHash, { size: 32 }),
      pad(withdrawUserOpHash, { size: 32 })
    ]) as `0x${string}`
    lockUserOp.signature = unifiedSignature
    withdrawUserOp.signature = unifiedSignature

    // Execute UserOp1
    await entryPoint.write.handleOps([[lockUserOp], alice.account.address])

    const metadata = await (
      paymasterAsOrigin as any
    ).read.getAtomicSwapMetadata([requestId])
    assert.equal(metadata.core.status, 1, 'Status should be NEW (1)')

    // ========================================
    // Step 4: XLP Claim funds (gives voucher)
    // ========================================
    console.log('\n=== Step 4: XLP issues voucher ===')
    const voucherExpiresAt = currentTimestamp + 3600n
    const voucherType = 0 // STANDARD

    // Generate signature message (same format as first test)
    const signatureMessage = encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { type: 'uint256', name: 'chainId' },
            { type: 'address', name: 'paymaster' },
            { type: 'address', name: 'sender' },
            {
              type: 'tuple[]',
              name: 'assets',
              components: [
                { type: 'address', name: 'erc20Token' },
                { type: 'uint256', name: 'amount' }
              ]
            },
            { type: 'uint256', name: 'maxUserOpCost' },
            { type: 'uint256', name: 'expiresAt' }
          ]
        },
        { type: 'bytes32', name: 'requestId' },
        { type: 'address', name: 'xlpAddress' },
        { type: 'uint256', name: 'expiresAt' },
        { type: 'uint8', name: 'voucherType' }
      ],
      [
        voucherRequest.destination,
        requestId,
        getAddress(xlpOperator.account.address),
        voucherExpiresAt,
        voucherType
      ]
    )

    // XLP signs the voucher (signMessage will add Ethereum message prefix)
    const xlpSignature = await xlpOperator.signMessage({
      message: { raw: signatureMessage }
    })

    // Build Voucher
    const voucher = {
      requestId,
      originationXlpAddress: getAddress(xlpOperator.account.address),
      voucherRequestDest: voucherRequest.destination,
      expiresAt: voucherExpiresAt,
      voucherType,
      xlpSignature
    }

    // XLP issues voucher (needs to be called with XLP's account)
    await (paymasterAsOriginXlp as any).write.issueVouchers([
      [{ voucherRequest, voucher }]
    ])

    // Verify voucher is issued
    const metadataAfterVoucher = await (
      paymasterAsOrigin as any
    ).read.getAtomicSwapMetadata([requestId])
    assert.equal(
      metadataAfterVoucher.core.status,
      2,
      'Status should be VOUCHER_ISSUED (2)'
    )
    assert.equal(
      getAddress(metadataAfterVoucher.core.voucherIssuerL2XlpAddress),
      getAddress(xlpOperator.account.address),
      'Voucher issuer should be XLP'
    )
    console.log('✓ Voucher issued by XLP')

    // ========================================
    // Step 5-8: UserOp2 - Use voucher to claim funds
    // ========================================
    console.log('\n=== Step 5-8: Alice uses voucher on destination chain ===')

    // In real scenarios, this is done via ERC-4337 UserOp
    // Here we verify destination chain status is NONE (voucher can be used)
    const destinationSwapBefore =
      await crossChainPaymaster.read.getIncomingAtomicSwap([requestId])
    assert.equal(
      destinationSwapBefore.status,
      0,
      'Destination status should be NONE before withdrawal'
    )
    console.log('✓ Voucher ready for use on destination chain')

    // ========================================
    // Step 5.5: Add paymasterSignature to pre-signed UserOp2
    // ========================================
    console.log(
      '\n=== Step 5.5: Add paymasterSignature to pre-signed UserOp2 ==='
    )
    console.log(
      'Now that voucher is ready, we can add paymasterSignature to UserOp2'
    )
    console.log(
      'The pre-signed signature remains valid because userOpHash does not include paymasterSignature'
    )

    // Build SessionData (empty for this test)
    const sessionData = {
      data: '0x' as `0x${string}`,
      ephemeralSignature: '0x' as `0x${string}`
    }

    const paymasterAndDataWithSig = addPaymasterSignatureToPaymasterAndData(
      paymasterAndDataWithoutSig,
      [voucher], // vouchers array
      sessionData
    )
    withdrawUserOp.paymasterAndData = paymasterAndDataWithSig

    const aliceBalanceBefore = await publicClient.getBalance({
      address: aliceAccountAddress
    })
    console.log('Alice AA account balance before:', aliceBalanceBefore)

    // Execute pre-signed UserOp2 (signature was already added earlier)
    await entryPoint.write.handleOps([[withdrawUserOp], alice.account.address])

    // Verify destination swap status
    const destinationSwapAfter =
      await crossChainPaymaster.read.getIncomingAtomicSwap([requestId])
    assert.equal(
      destinationSwapAfter.status,
      6,
      'Destination status should be SUCCESSFUL'
    )

    // Check Alice's AA account balance after
    const aliceBalanceAfter = await publicClient.getBalance({
      address: aliceAccountAddress
    })
    console.log('Alice AA account balance after:', aliceBalanceAfter)
    assert.ok(
      aliceBalanceAfter > aliceBalanceBefore,
      'Alice should have received ETH'
    )

    console.log('✓ Voucher used successfully via SimpleMultiChainAccount!')
    console.log(
      '✓ Alice received:',
      aliceBalanceAfter - aliceBalanceBefore,
      'wei'
    )

    // ========================================
    // Step 9: Wait an hour (dispute period)
    // ========================================
    console.log('\n=== Step 9: Wait for dispute period (1 hour) ===')

    await networkHelpers.time.increase(3601n) // 1 hour + 1 second
    console.log('✓ Dispute period passed (1 hour)')

    // ========================================
    // Step 10: XLP Unlock & reuse funds
    // ========================================
    console.log(
      '\n=== Step 10: XLP withdraws user deposit from origin chain ==='
    )

    // XLP withdraws user's locked funds from origin chain
    await (paymasterAsOriginXlp as any).write.withdrawFromUserDeposit([
      [voucherRequest]
    ])

    // Verify final status
    const finalMetadata = await (
      paymasterAsOrigin as any
    ).read.getAtomicSwapMetadata([requestId])
    assert.equal(
      finalMetadata.core.status,
      6,
      'Status should be SUCCESSFUL (6)'
    )

    // Verify XLP received user's funds (as internal balance)
    const xlpTokenBalance = await crossChainPaymaster.read.tokenBalanceOf([
      testToken.address,
      xlpOperator.account.address
    ])
    assert.ok(xlpTokenBalance > 0n, 'XLP should have received tokens')

    console.log('✓ XLP successfully withdrew user deposit')
    console.log('✓ Atomic swap completed successfully!')
    console.log('\n=== Cross-Chain Atomic Swap Flow Complete ===')
  })

  /**
   * Test user cancellation flow.
   * When no XLP claims, user can cancel after USER_CANCELLATION_DELAY.
   */
  it('should allow user to cancel if no XLP claims', async () => {
    const alice = walletClients[0]

    // Get paymaster reference with OriginSwapManager ABI
    const paymasterAsOrigin = getPaymasterWithOriginAbi(alice)

    const chainId = await publicClient.getChainId()
    const currentBlock = await publicClient.getBlock()
    const currentTimestamp = currentBlock.timestamp

    // Mint tokens to Alice
    const swapAmount = parseEther('1')
    const maxFeePercent = 100n
    const amountWithMaxFee = swapAmount + (swapAmount * maxFeePercent) / 10000n

    await testToken.write.sudoMint([alice.account.address, amountWithMaxFee])
    await testToken.write.sudoApprove([
      alice.account.address,
      crossChainPaymaster.address,
      amountWithMaxFee
    ])

    // Build request
    const voucherRequest = {
      origination: {
        chainId: BigInt(chainId),
        paymaster: getAddress(crossChainPaymaster.address),
        sender: getAddress(alice.account.address),
        assets: [
          {
            erc20Token: getAddress(testToken.address),
            amount: swapAmount
          }
        ],
        feeRule: {
          startFeePercentNumerator: 10n,
          maxFeePercentNumerator: maxFeePercent,
          feeIncreasePerSecond: 1n,
          unspentVoucherFee: parseEther('0.01')
        },
        senderNonce: 0n,
        allowedXlps: [deployer.account.address] // An XLP that won't claim
      },
      destination: {
        chainId: BigInt(chainId),
        paymaster: getAddress(crossChainPaymaster.address),
        sender: getAddress(alice.account.address),
        assets: [
          {
            erc20Token: NATIVE_ETH,
            amount: parseEther('0.9')
          }
        ],
        maxUserOpCost: parseEther('0.1'),
        expiresAt: currentTimestamp + 3600n
      }
    }

    // Alice locks funds
    await (paymasterAsOrigin as any).write.lockUserDeposit([voucherRequest], {
      account: alice.account
    })

    const requestId = getVoucherRequestId(voucherRequest)

    // Wait for USER_CANCELLATION_DELAY (5 minutes)
    await networkHelpers.time.increase(301n)

    // Alice cancels the request
    await (paymasterAsOrigin as any).write.cancelVoucherRequest(
      [voucherRequest],
      { account: alice.account }
    )

    // Verify status changed to CANCELLED

    const metadata = await (
      paymasterAsOrigin as any
    ).read.getAtomicSwapMetadata([requestId])
    assert.equal(metadata.core.status, 3, 'Status should be CANCELLED (3)')

    // Verify Alice received original amount back (without fee)
    const aliceBalanceAfter = await testToken.read.balanceOf([
      alice.account.address
    ])
    assert.equal(
      aliceBalanceAfter,
      swapAmount,
      'Alice should have received her original swap amount back'
    )

    console.log('✓ User successfully cancelled and recovered funds')
  })

  /**
   * Test XLP balance queries.
   */
  it('should correctly query XLP balances and registration status', async () => {
    // Use different accounts to avoid conflicts with previous tests
    const xlp1 = walletClients[2]
    const xlp2 = walletClients[3]

    // Register two XLPs
    await crossChainPaymaster.write.onL1XlpChainInfoAdded([
      xlp1.account.address,
      xlp1.account.address
    ])
    await crossChainPaymaster.write.onL1XlpChainInfoAdded([
      xlp2.account.address,
      xlp2.account.address
    ])

    // Verify registration status
    assert.equal(
      await crossChainPaymaster.read.isL2XlpRegistered([xlp1.account.address]),
      true
    )
    assert.equal(
      await crossChainPaymaster.read.isL2XlpRegistered([xlp2.account.address]),
      true
    )

    // XLP1 deposits
    await crossChainPaymaster.write.depositToXlp([xlp1.account.address], {
      value: parseEther('5'),
      account: xlp1.account
    })

    // XLP2 deposits
    await crossChainPaymaster.write.depositToXlp([xlp2.account.address], {
      value: parseEther('3'),
      account: xlp2.account
    })

    // Verify balances
    assert.equal(
      await crossChainPaymaster.read.nativeBalanceOf([xlp1.account.address]),
      parseEther('5')
    )
    assert.equal(
      await crossChainPaymaster.read.nativeBalanceOf([xlp2.account.address]),
      parseEther('3')
    )

    // Query XLP list (may include XLPs from previous tests)
    const xlps = await crossChainPaymaster.read.getXlps([0n, 10n])
    assert.ok(xlps.length >= 2, 'Should have at least 2 registered XLPs')
    // Verify our two XLPs are in the list
    // XlpEntry is a struct with l1XlpAddress and l2XlpAddress
    const xlpL2Addresses = xlps.map((x: any) => getAddress(x.l2XlpAddress))
    assert.ok(
      xlpL2Addresses.includes(getAddress(xlp1.account.address)),
      'xlp1 should be registered'
    )
    assert.ok(
      xlpL2Addresses.includes(getAddress(xlp2.account.address)),
      'xlp2 should be registered'
    )

    console.log('✓ XLP registration and balance queries work correctly')
  })
})

/**
 * Build a PackedUserOperation for SimpleMultiChainAccount
 */
async function buildUserOp(
  accountAddress: `0x${string}`,
  entryPoint: any,
  callData: `0x${string}`,
  paymasterAndData: `0x${string}` = '0x',
  nonce?: bigint
): Promise<any> {
  // Use provided nonce or get current nonce
  const userOpNonce =
    nonce ?? (await entryPoint.read.getNonce([accountAddress, 0n]))

  // Pack accountGasLimits: uint128(verificationGasLimit) || uint128(callGasLimit)
  const verificationGasLimit = 500000n // Increased for complex operations
  const callGasLimit = 500000n // Increased for complex operations
  const accountGasLimits =
    pad(toHex(verificationGasLimit), { size: 16 }) +
    pad(toHex(callGasLimit), { size: 16 }).slice(2)

  // Pack gasFees: uint128(maxPriorityFeePerGas) || uint128(maxFeePerGas)
  const maxPriorityFeePerGas = 1000000000n
  const maxFeePerGas = 1000000000n
  const gasFees =
    pad(toHex(maxPriorityFeePerGas), { size: 16 }) +
    pad(toHex(maxFeePerGas), { size: 16 }).slice(2)

  // Build UserOperation (PackedUserOperation format)
  const userOp = {
    sender: accountAddress,
    nonce: userOpNonce,
    initCode: '0x' as `0x${string}`,
    callData,
    accountGasLimits: accountGasLimits as `0x${string}`,
    preVerificationGas: 100000n, // Increased
    gasFees: gasFees as `0x${string}`,
    paymasterAndData,
    signature: '0x' as `0x${string}`
  }

  // Calculate userOpHash
  const userOpHash = await entryPoint.read.getUserOpHash([userOp])

  return { userOp, userOpHash }
}

/**
 * Sign UserOperation for SimpleMultiChainAccount
 * SimpleMultiChainAccount expects signature to be the userOpHash as bytes (32 bytes)
 */
function signUserOp(userOpHash: `0x${string}`): `0x${string}` {
  // SimpleMultiChainAccount expects signature to contain the userOpHash
  // The signature is just the userOpHash as bytes (32 bytes)
  return pad(userOpHash, { size: 32 })
}

/**
 * Encode paymasterAndData WITHOUT paymasterSignature (for EntryPoint v0.9 parallelizable signing)
 * Format: paymaster(20) + validationGasLimit(16) + postOpGasLimit(16) + paymasterData
 * According to ERC-4337 v0.9 spec:
 * - paymasterAndData (if non-empty) = paymaster(20) || verificationGasLimit(16) || postOpGasLimit(16) || paymasterData
 * - paymasterSignature is added later by appending: paymasterSignature || uint16(paymasterSignature.length) || PAYMASTER_SIG_MAGIC
 * This allows users to sign UserOp before getting the voucher, then add paymasterSignature later.
 *
 * @param fakeSignatureLength - Optional. If provided, adds a fake signature (all zeros) with this length
 *                              and the suffix (uint16(length) || MAGIC). This ensures userOpHash consistency
 *                              because EntryPoint's paymasterDataKeccak will hash the same data structure
 *                              (base || signature || uint16(length) || MAGIC) in both cases.
 */
function encodePaymasterAndDataWithoutSignature(
  paymasterAddress: `0x${string}`,
  validationGasLimit: bigint,
  postOpGasLimit: bigint,
  destinationVoucherRequestsData: any,
  fakeSignatureLength?: number
): `0x${string}` {
  const PAYMASTER_SIG_MAGIC = '0x22e325a297439656' as const
  const PAYMASTER_SUFFIX_LEN = 10 // uint16(2 bytes) + MAGIC(8 bytes)

  // Encode paymasterData (DestinationVoucherRequestsData)
  const paymasterData = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          {
            type: 'tuple[][]',
            name: 'vouchersAssetsMinimums',
            components: [
              { type: 'address', name: 'erc20Token' },
              { type: 'uint256', name: 'amount' }
            ]
          },
          { type: 'address', name: 'ephemeralSigner' }
        ]
      }
    ],
    [
      {
        vouchersAssetsMinimums:
          destinationVoucherRequestsData.vouchersAssetsMinimums,
        ephemeralSigner: destinationVoucherRequestsData.ephemeralSigner
      }
    ]
  )

  // Build base paymasterAndData
  const base = concat([
    pad(paymasterAddress, { size: 20 }), // paymaster address
    pad(toHex(validationGasLimit), { size: 16 }), // validationGasLimit
    pad(toHex(postOpGasLimit), { size: 16 }), // postOpGasLimit
    paymasterData // paymasterData
  ]) as `0x${string}`

  // If fakeSignatureLength is provided, add fake signature + suffix
  // This ensures EntryPoint's paymasterDataKeccak hashes the same structure
  // (base || signature || uint16(length) || MAGIC) in both cases
  if (fakeSignatureLength !== undefined && fakeSignatureLength > 0) {
    // Create fake signature (all zeros) with the specified length
    const fakeSignature = ('0x' +
      '00'.repeat(fakeSignatureLength)) as `0x${string}`
    const sigLengthHex = pad(toHex(BigInt(fakeSignatureLength)), { size: 2 })

    return concat([
      base as `0x${string}`,
      fakeSignature,
      sigLengthHex,
      PAYMASTER_SIG_MAGIC
    ]) as `0x${string}`
  }

  // Otherwise, return just the base (no signature suffix)
  return base
}

/**
 * Add paymasterSignature to existing paymasterAndData (EntryPoint v0.9 parallelizable signing)
 * Replaces the fake signature section (if present) with the actual paymasterSignature
 */
function addPaymasterSignatureToPaymasterAndData(
  paymasterAndDataWithoutSig: `0x${string}`,
  vouchers: any[],
  sessionData: any
): `0x${string}` {
  const PAYMASTER_SIG_MAGIC = '0x22e325a297439656' as const
  const PAYMASTER_SUFFIX_LEN = 10 // uint16(2 bytes) + MAGIC(8 bytes)

  // Encode paymasterSignature (AtomicSwapVoucher[] + SessionData)
  const paymasterSignature = encodeAbiParameters(
    [
      {
        type: 'tuple[]',
        components: [
          { type: 'bytes32', name: 'requestId' },
          { type: 'address', name: 'originationXlpAddress' },
          {
            type: 'tuple',
            name: 'voucherRequestDest',
            components: [
              { type: 'uint256', name: 'chainId' },
              { type: 'address', name: 'paymaster' },
              { type: 'address', name: 'sender' },
              {
                type: 'tuple[]',
                name: 'assets',
                components: [
                  { type: 'address', name: 'erc20Token' },
                  { type: 'uint256', name: 'amount' }
                ]
              },
              { type: 'uint256', name: 'maxUserOpCost' },
              { type: 'uint256', name: 'expiresAt' }
            ]
          },
          { type: 'uint256', name: 'expiresAt' },
          { type: 'uint8', name: 'voucherType' },
          { type: 'bytes', name: 'xlpSignature' }
        ]
      },
      {
        type: 'tuple',
        components: [
          { type: 'bytes', name: 'data' },
          { type: 'bytes', name: 'ephemeralSignature' }
        ]
      }
    ],
    [vouchers, sessionData]
  )

  const sigLengthBytes = (paymasterSignature.length - 2) / 2
  const sigLengthHex = pad(toHex(BigInt(sigLengthBytes)), { size: 2 })
  const sigLengthHexWithoutPrefix = sigLengthHex.slice(2)
  const magicHex = PAYMASTER_SIG_MAGIC.slice(2) // Remove '0x' prefix
  const magicIndex = paymasterAndDataWithoutSig.lastIndexOf(magicHex)

  if (magicIndex !== -1) {
    const uint16Hex = paymasterAndDataWithoutSig.slice(
      magicIndex - 4,
      magicIndex
    )
    const fakeSigLen = parseInt(uint16Hex, 16)
    const baseEndIndex = magicIndex - 4 - fakeSigLen * 2
    const base = paymasterAndDataWithoutSig.slice(0, baseEndIndex)

    if (fakeSigLen !== sigLengthBytes) {
      throw new Error(
        `Fake signature length (${fakeSigLen}) does not match real signature length (${sigLengthBytes})`
      )
    }

    return concat([
      base as `0x${string}`,
      paymasterSignature,
      sigLengthHex,
      PAYMASTER_SIG_MAGIC
    ]) as `0x${string}`
  } else {
    return concat([
      paymasterAndDataWithoutSig,
      paymasterSignature,
      sigLengthHex,
      PAYMASTER_SIG_MAGIC
    ]) as `0x${string}`
  }
}

/**
 * Encode paymasterAndData for CrossChainPaymaster (complete version with signature)
 * Format: paymaster(20) + validationGasLimit(16) + postOpGasLimit(16) + signedPaymasterData + paymasterSignature + uint16(sigLen) + PAYMASTER_SIG_MAGIC(8)
 * This is a convenience function that combines both steps.
 */
function encodePaymasterAndData(
  paymasterAddress: `0x${string}`,
  validationGasLimit: bigint,
  postOpGasLimit: bigint,
  destinationVoucherRequestsData: any,
  vouchers: any[],
  sessionData: any
): `0x${string}` {
  const paymasterAndDataWithoutSig = encodePaymasterAndDataWithoutSignature(
    paymasterAddress,
    validationGasLimit,
    postOpGasLimit,
    destinationVoucherRequestsData
  )
  return addPaymasterSignatureToPaymasterAndData(
    paymasterAndDataWithoutSig,
    vouchers,
    sessionData
  )
}

function getVoucherRequestId(voucherRequest: any): `0x${string}` {
  const encoded = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          {
            type: 'tuple',
            name: 'origination',
            components: [
              { type: 'uint256', name: 'chainId' },
              { type: 'address', name: 'paymaster' },
              { type: 'address', name: 'sender' },
              {
                type: 'tuple[]',
                name: 'assets',
                components: [
                  { type: 'address', name: 'erc20Token' },
                  { type: 'uint256', name: 'amount' }
                ]
              },
              {
                type: 'tuple',
                name: 'feeRule',
                components: [
                  { type: 'uint256', name: 'startFeePercentNumerator' },
                  { type: 'uint256', name: 'maxFeePercentNumerator' },
                  { type: 'uint256', name: 'feeIncreasePerSecond' },
                  { type: 'uint256', name: 'unspentVoucherFee' }
                ]
              },
              { type: 'uint256', name: 'senderNonce' },
              { type: 'address[]', name: 'allowedXlps' }
            ]
          },
          {
            type: 'tuple',
            name: 'destination',
            components: [
              { type: 'uint256', name: 'chainId' },
              { type: 'address', name: 'paymaster' },
              { type: 'address', name: 'sender' },
              {
                type: 'tuple[]',
                name: 'assets',
                components: [
                  { type: 'address', name: 'erc20Token' },
                  { type: 'uint256', name: 'amount' }
                ]
              },
              { type: 'uint256', name: 'maxUserOpCost' },
              { type: 'uint256', name: 'expiresAt' }
            ]
          }
        ]
      }
    ],
    [voucherRequest]
  )
  return keccak256(encoded)
}
