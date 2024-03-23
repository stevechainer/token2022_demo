import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import expect from "expect.js";
import { Transferhook } from "../target/types/transferhook";
import {
  Connection,
  PublicKey,
  Signer,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createInitializeInterestBearingMintInstruction,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createTransferCheckedWithTransferHookInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  createUpdateRateInterestBearingMintInstruction
} from "@solana/spl-token";

async function newAccountWithLamports(
  connection: Connection,
  lamports = 100000000000
): Promise<Signer> {
  const account = anchor.web3.Keypair.generate();
  const signature = await connection.requestAirdrop(
    account.publicKey,
    lamports
  );
  await connection.confirmTransaction(signature);
  return account;
}

describe("transfer-hook", () => {
  const program = anchor.workspace.Transferhook as Program<Transferhook>;

  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  let authority: Signer;
  let recipient: Signer;
  let authorityATA: PublicKey;
  let recipientATA: PublicKey;
  let mint: Signer;
  let statePDA: PublicKey;
  const TRANSFER_HOOK_PROGRAM_ID = program.programId;
  const decimals = 9;
  const rate = 5; // to get fast interest in low time
  const provider = anchor.getProvider();

  before("prepare accounts", async () => {
    authority = await newAccountWithLamports(provider.connection);
    recipient = await newAccountWithLamports(provider.connection);
    mint = anchor.web3.Keypair.generate();
    authorityATA = getAssociatedTokenAddressSync(
      mint.publicKey,
      authority.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    recipientATA = getAssociatedTokenAddressSync(
      mint.publicKey,
      recipient.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const [_statePDA, _bump] = PublicKey.findProgramAddressSync(
      [authority.publicKey.toBuffer()],
      program.programId
    );
    statePDA = _statePDA;

    await program.methods
      .initialize(false)
      .accounts({
        state: statePDA,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();
  });

  it("create mint with transfer-hook", async () => {
    // 1. Create mint account
    // 2. Initialize transfer-hook
    // 3. Initialize mint account
    const mintLen = getMintLen([ExtensionType.InterestBearingConfig, ExtensionType.TransferHook]);
    const lamports = await provider.connection.getMinimumBalanceForRentExemption(mintLen);

    const mintTransaction = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: authority.publicKey,
        newAccountPubkey: mint.publicKey,
        space: mintLen,
        lamports: lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeInterestBearingMintInstruction(
        mint.publicKey,
        authority.publicKey,
        0,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeTransferHookInstruction(
        mint.publicKey,
        authority.publicKey,
        TRANSFER_HOOK_PROGRAM_ID,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMintInstruction(
        mint.publicKey,
        decimals,
        authority.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID
      )
    );

    await sendAndConfirmTransaction(provider.connection, mintTransaction, [
      authority,
      mint,
    ]);
  });

  it("setup extra account metas", async () => {
    // 1. Create extra account

    const [_extractAccountMetaPDA, _bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()],
      TRANSFER_HOOK_PROGRAM_ID
    );

    const initExtraAccountMetaInstruction = await program.methods
      .initializeExtraAccountMetaList(_bump)
      .accounts({
        extraAccount: _extractAccountMetaPDA,
        state: statePDA,
        mint: mint.publicKey,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .instruction();

    const setupTransaction = new Transaction().add(
      initExtraAccountMetaInstruction,
      // Transfer some lamports to the extra account for rent
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: _extractAccountMetaPDA,
        lamports: 10000000,
      }),
     // Transfer some lamports to the extra account for rent
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: statePDA,
        lamports: 10000000,
      })
    );

    const hash = await sendAndConfirmTransaction(
      provider.connection,
      setupTransaction,
      [authority]
    );
  });

  it("mint token", async () => {
    // 1. Create associated token account for authority
    // 1. Create associated token account for recipient
    // 2. Mint 100 tokens to authority

    const mintToTransaction = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        authority.publicKey,
        authorityATA,
        authority.publicKey,
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        authority.publicKey,
        recipientATA,
        recipient.publicKey,
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      ),
      createMintToInstruction(
        mint.publicKey,
        authorityATA,
        authority.publicKey,
        100 * 10 ** decimals,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );

    const res = await sendAndConfirmTransaction(
      provider.connection,
      mintToTransaction,
      [authority]
    );
  });

  it("transfer token", async () => {
    // 1. Create associated token account for recipient
    // 2. Transfer 1 token to recipient
    const originalBalance = Number((
      await provider.connection.getTokenAccountBalance(authorityATA)
    ).value.amount)

    let transferInstruction = await createTransferCheckedWithTransferHookInstruction(
      provider.connection,
      authorityATA,
      mint.publicKey,
      recipientATA,
      authority.publicKey,
      BigInt(1 * 10 ** decimals),
      decimals,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    let transferTransaction = new Transaction().add(transferInstruction);
    let signature = await sendAndConfirmTransaction(
      provider.connection,
      transferTransaction,
      [authority]
    );

    const newBalance = Number((
      await provider.connection.getTokenAccountBalance(authorityATA)
    ).value.amount)

    expect(newBalance).to.be.equal(originalBalance - 1 * 10 ** decimals);

    expect((await program.account.state.fetch(statePDA)).paused).to.be(false);

    await program.methods
      .changePausedState(true)
      .accounts({
        state: statePDA,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();

     let data = await program.account.state.fetch(statePDA)

    expect((await program.account.state.fetch(statePDA)).paused).to.be(true);

    transferInstruction = await createTransferCheckedWithTransferHookInstruction(
      provider.connection,
      authorityATA,
      mint.publicKey,
      recipientATA,
      authority.publicKey,
      BigInt(1 * 10 ** decimals),
      decimals,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    transferTransaction = new Transaction().add(transferInstruction);

    signature = await provider.connection.sendTransaction(
      transferTransaction,
      [authority],
      {
        skipPreflight: true,
        preflightCommitment: 'confirmed',
      },
    );

    let status = await provider.connection.confirmTransaction(signature)

    expect(status.value.err['InstructionError'][1]['Custom']).to.be.equal(123);
    expect(Number((
      await provider.connection.getTokenAccountBalance(authorityATA)
    ).value.amount)).to.be.equal(newBalance);

    // Expect same error on simulation
    status = await provider.connection.simulateTransaction(
      transferTransaction,
      [authority],
    );

    expect(status.value.err['InstructionError'][1]['Custom']).to.be.equal(123);
    expect(Number((
      await provider.connection.getTokenAccountBalance(authorityATA)
    ).value.amount)).to.be.equal(newBalance);

    // back to normal
    await program.methods
      .changePausedState(false)
      .accounts({
        state: statePDA,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();
  });

  it("wait for interest - Local validator doesn't support interest (?)", async function () {
    const res = await sendAndConfirmTransaction(
      provider.connection,
      new Transaction().add(
        createMintToInstruction(
          mint.publicKey,
          authorityATA,
          authority.publicKey,
          BigInt('1000000000000'),
          [],
          TOKEN_2022_PROGRAM_ID
        ),
      ),
      [authority],
          );
    console.log('transferhook.ts:321');

    // Tests don't restart the network state so we already have minted tokens
    console.log(await provider.connection.getTokenAccountBalance(authorityATA))

    const balance = Number((
      await provider.connection.getTokenAccountBalance(authorityATA)
    ).value.amount)



    console.log("Start: ", await provider.connection.getTokenAccountBalance(authorityATA))
    for (let i = 0; i < 120; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));

      let tx = new Transaction().add(
        createUpdateRateInterestBearingMintInstruction(
          mint.publicKey,
          authority.publicKey,
          rate * i,
          [authority],
          TOKEN_2022_PROGRAM_ID
        )
      )

      let signature = await provider.connection.sendTransaction(
        tx,
        [authority],
        {
          skipPreflight: true,
          preflightCommitment: 'confirmed',
          maxRetries: 100,
          minContextSlot: 0,
        }
      );

      let status = await provider.connection.confirmTransaction(signature)
      console.log(i * 50, " : ", status)


      console.log(`${i * 50} : `, await provider.connection.getTokenAccountBalance(authorityATA))

    }
  });
});
