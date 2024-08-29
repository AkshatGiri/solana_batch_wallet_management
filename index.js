import { Command, Option } from "commander";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmRawTransaction,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import fs from "fs/promises";
import bs58 from "bs58";
import inquirer from "inquirer";
import "dotenv/config";

const RPC_ENDPOINT = process.env.RPC_ENDPOINT;

if (!RPC_ENDPOINT) {
  console.error(
    "Please add RPC_ENDPOINT to the .env file in the root of the project."
  );
  process.exit(1);
}

const program = new Command();

program
  .name("solana batch wallets manager")
  .description(
    "Helps generate multiple wallets. Fund them and get sol back from them."
  )
  .version("0.0.1");

program
  .command("generate-wallets")
  .description("generates wallets")
  .argument("<number>", "number of wallets to generate")
  .addOption(
    new Option("-o, --output <file>", "output file name or path").default(
      "wallets.json"
    )
  )
  .action(generateWallets);

program
  .command("fund-wallets")
  .description("Fund wallets with sol.")
  .argument(
    "<walletsFile>",
    "json file containing wallets. File should have an array of objects with publicKey field."
  )
  .argument("<amount>", "amount of sol to send to each wallet")
  .argument("<from>", "base58 private key of the wallet to send sol from")
  .action(fundWallets);

program
  .command("consolidate-sol")
  .description("Consolidate sol from multiple wallets to a single wallet.")
  .argument(
    "<walletsFile>",
    "json file containing wallets. File should have an array of objects with privateKey and publicKey field."
  )
  .argument("<toAddress>", "public Key of the wallet to send sol to.")
  // TODO: We can probably add an option to say how much sol to send per wallet
  // although most of the time we want this to be all the sol in the wallet.
  .action(consolidateSol);

program
  .command("get-balances")
  .description("Get sol balance of wallets.")
  .argument(
    "<walletsFile>",
    "json file containing wallets. File should have an array of objects with publicKey field."
  )
  .action(getBalances);

program
  .command("get-token-balances")
  .description("Get specified token balance for each wallet.")
  .argument(
    "<walletsFile>",
    "json file containing wallets. File should have an array of objects with publicKey field."
  )
  .argument("<tokenMint>", "token mint address")
  .action(getTokenBalances);

////////////////////
// IMPLEMENTATION //
////////////////////

async function fundWallets(walletsFilePath, solAmountStr, senderPrivateKey) {
  const isFilePathValid = await doesFileExist(walletsFilePath);
  if (!isFilePathValid) {
    console.error(`Wallets file at ${walletsFilePath} does not exist.`);
    process.exit(1);
  }

  const walletsInfo = JSON.parse(await fs.readFile(walletsFilePath, "utf-8"));

  walletsInfo.forEach((w) => {
    if (!w.publicKey) {
      console.error(`Invalid wallet in file: ${w}`);
      process.exit(1);
    }
  });

  const wallets = walletsInfo.map((w) => new PublicKey(w.publicKey));

  const sender = Keypair.fromSecretKey(bs58.decode(senderPrivateKey));

  const solPerWallet = solToLamports(parseFloat(solAmountStr));

  const connection = new Connection(RPC_ENDPOINT, "confirmed");

  // Get sender balance
  const senderBalance = await connection.getBalance(sender.publicKey);
  console.log(`Sender SOL balance: ${lamportsToSol(senderBalance)}`);
  const totalSolTransfer = solPerWallet * BigInt(wallets.length);
  if (senderBalance < totalSolTransfer) {
    console.error(
      `Sender does not have enough balance to fund all wallets. ${lamportsToSol(
        senderBalance
      )} < ${lamportsToSol(totalSolTransfer)}`
    );
    process.exit(1);
  }

  // Create transfer transactions
  const transfersPerTx = 10;
  const walletsChunked = chunkArray(wallets, transfersPerTx);

  const { proceed } = await inquirer.prompt([
    {
      type: "input",
      name: "proceed",
      message: `Sending ${lamportsToSol(totalSolTransfer)} sol in total to ${
        wallets.length
      } wallets. Proceed? (y/n)`,
    },
  ]);

  if (proceed.trim().toLowerCase() !== "y") {
    console.log("Exiting.");
    process.exit(0);
  }

  const blockhash = (await connection.getLatestBlockhash()).blockhash;

  const txs = walletsChunked.map((chunk) => {
    const tx = new Transaction();
    chunk.forEach((wallet) => {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: sender.publicKey,
          toPubkey: wallet,
          lamports: solPerWallet,
        })
      );
    });

    tx.recentBlockhash = blockhash;
    tx.feePayer = sender.publicKey;
    tx.sign(sender);

    return tx;
  });

  // Send transactions

  console.log(`Sending ${txs.length} transactions.`);

  const txsResponses = await Promise.allSettled(
    txs.map((tx) =>
      sendAndConfirmTransaction(connection, tx, [sender], {
        commitment: "confirmed",
      })
    )
  );

  const successfulTxs = txsResponses.filter((tx) => tx.status === "fulfilled");
  const failedTxs = txsResponses.filter((tx) => tx.status === "rejected");
  console.log(`${successfulTxs.length} successful transactions.`);
  console.log(`${failedTxs.length} failed transactions.`);

  console.log("\n========= SUCCESSFUL TXS =========\n");

  successfulTxs.forEach((txResponse) => {
    const { value: sig } = txResponse;

    console.log(`https://solscan.io/tx/${sig}`);
  });

  if (failedTxs.length === 0) return;

  console.log("\n========= FAILED TXS =========m");
  failedTxs.forEach((txResponse) => {
    const { value: sig } = txResponse;

    console.log(`https://solscan.io/tx/${sig}`);
  });

  // TOOD: Add retry logic for failed transactions.
}

async function generateWallets(numberOfWalletsStr, options) {
  try {
    const wallets = [];
    const numOfWallets = parseInt(numberOfWalletsStr);
    const { output: outputFilePath } = options;

    const fileAlreadyExists = await doesFileExist(outputFilePath);

    if (fileAlreadyExists) {
      const { proceed } = await inquirer.prompt([
        {
          type: "input",
          name: "proceed",
          message: `A file at ${outputFilePath} already exists. Do you want to overwrite it? (y/n)`,
        },
      ]);

      if (proceed.trim().toLowerCase() !== "y") {
        console.log("Exiting.");
        process.exit(0);
      }
    }

    for (let i = 0; i < numOfWallets; i++) {
      const wallet = Keypair.generate();
      wallets.push(wallet);
    }

    await fs.writeFile(
      outputFilePath,
      JSON.stringify(
        wallets.map((w) => ({
          privateKey: bs58.encode(w.secretKey),
          publicKey: w.publicKey.toBase58(),
        })),
        null,
        4
      )
    );

    console.log(
      `Successfully written ${numOfWallets} wallets to ${outputFilePath}`
    );
  } catch (error) {
    console.error("There was an error generating wallets: ", error);
  }
}

async function getBalances(walletsFilePath) {
  const isFilePathValid = await doesFileExist(walletsFilePath);
  if (!isFilePathValid) {
    console.error(`Wallets file at ${walletsFilePath} does not exist.`);
    process.exit(1);
  }

  const walletsInfo = JSON.parse(await fs.readFile(walletsFilePath, "utf-8"));

  walletsInfo.forEach((w) => {
    if (!w.publicKey) {
      console.error(`Invalid wallet in file: ${w}`);
      process.exit(1);
    }
  });

  console.log(`Fetching SOL Balance for ${walletsInfo.length} wallets.`);

  const wallets = walletsInfo.map((w) => new PublicKey(w.publicKey));

  const connection = new Connection(RPC_ENDPOINT, "confirmed");

  const balances = await Promise.allSettled(
    wallets.map(async (wallet) => {
      const balance = await connection.getBalance(wallet);
      return { wallet, balance };
    })
  );

  const failedBalances = balances.filter((b) => b.status === "rejected");
  const successfulBalances = balances.filter((b) => b.status === "fulfilled");

  const totalSol = successfulBalances.reduce(
    (acc, b) => acc + b.value.balance,
    0
  );

  console.table(
    successfulBalances.map((b) => ({
      wallet: b.value.wallet.toBase58(),
      balance: lamportsToSol(b.value.balance),
    }))
  );

  if (failedBalances.length > 0) {
    console.error(
      `Failed to get balance for ${failedBalances.length} wallets.`
    );
  }

  console.log(`Total sol: ${lamportsToSol(totalSol)}`);
}

async function consolidateSol(walletsFilePath, toAddress) {
  const wallets = await getWalletsFromFile(walletsFilePath);
  const toPubKey = new PublicKey(toAddress);

  const connection = new Connection(RPC_ENDPOINT, "confirmed");

  // fetch sol balances for all addresses
  const balances = await Promise.all(
    wallets.map(async (wallet) => {
      const balance = await connection.getBalance(wallet.publicKey);
      return {
        wallet,
        balance,
        transferableBalance: BigInt(balance) - solToLamports(0.001),
      };
    })
  );

  const totalSolTransfer = balances.reduce(
    (acc, b) => acc + b.transferableBalance,
    0n
  );

  const { proceed } = await inquirer.prompt([
    {
      type: "input",
      name: "proceed",
      message: `Sending ${lamportsToSol(totalSolTransfer)} sol from ${
        wallets.length
      } wallets to ${toAddress}. Proceed? (y/n)`,
    },
  ]);

  if (proceed.trim().toLowerCase() !== "y") {
    console.log("Exiting.");
    process.exit(0);
  }

  // Chunk wallets into groups for each transaction
  const transfersPerTx = 5;
  const chunked = chunkArray(balances, transfersPerTx);

  const blockhash = (await connection.getLatestBlockhash()).blockhash;

  const txs = chunked.map((chunk) => {
    const tx = new Transaction();
    chunk.forEach(({ wallet, transferableBalance }) => {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: toPubKey,
          lamports: transferableBalance,
        })
      );
    });

    const messageV0 = new TransactionMessage({
      payerKey: chunk[0].wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: tx.instructions,
    }).compileToV0Message([]);

    const versionedTx = new VersionedTransaction(messageV0);
    versionedTx.sign(chunk.map(({ wallet }) => wallet));

    return versionedTx;
  });

  // Send transactions
  console.log(`Sending ${txs.length} transactions.`);

  const txsResponses = await Promise.allSettled(
    txs.map((tx) =>
      sendAndConfirmRawTransaction(
        connection,
        tx.serialize(),
        { maxRetries: 5 },
        { commitment: "confirmed" }
      )
    )
  );

  const successfulTxs = txsResponses.filter((tx) => tx.status === "fulfilled");
  const failedTxs = txsResponses.filter((tx) => tx.status === "rejected");
  console.log(`${successfulTxs.length} successful transactions.`);
  console.log(`${failedTxs.length} failed transactions.`);

  console.log("\n========= SUCCESSFUL TXS =========\n");

  successfulTxs.forEach((txResponse) => {
    const { value: sig } = txResponse;

    console.log(`https://solscan.io/tx/${sig}`);
  });

  if (failedTxs.length === 0) return;

  console.log("\n========= FAILED TXS =========m");
  failedTxs.forEach((txResponse) => {
    const { value: sig } = txResponse;

    console.log(`https://solscan.io/tx/${sig}`);
  });
}

async function getTokenBalances(walletsFilePath, tokenMint) {
  const wallets = await getWalletsFromFile(walletsFilePath);

  const connection = new Connection(RPC_ENDPOINT, "confirmed");

  const token = new PublicKey(tokenMint);

  const walletAtas = await Promise.all(
    wallets.map(async (wallet) => {
      const res = await connection.getTokenAccountsByOwner(
        wallet.publicKey,
        { mint: token },
        "confirmed"
      );

      if (res.value.length === 0) {
        return null;
      }
      return res.value[0];
    })
  );

  const balances = await Promise.all(
    walletAtas.map(async (ata) => {
      if (!ata) {
        return {
          amount: "0",
          decimals: 0,
          uiAmount: 0,
          uiAmountString: "0",
        };
      }

      const balance = await connection.getTokenAccountBalance(ata.pubkey);
      return balance.value;
    })
  );

  console.table(
    wallets.map((w, i) => {
      const balance = balances[i];
      return {
        wallet: w.publicKey.toBase58(),
        ata: walletAtas[i] ? walletAtas[i].pubkey.toBase58() : "N/A",
        balance: balance.uiAmount,
      };
    })
  );

  console.log(`Fetched token balances for ${wallets.length} wallets.`);

  const totalBalance = balances.reduce((acc, b) => acc + b.uiAmount, 0);

  console.log(`Total Balance: ${totalBalance.toLocaleString()}`);
}

////////////////////
// Util functions //
////////////////////

async function getWalletsFromFile(filePath) {
  const isFilePathValid = await doesFileExist(filePath);
  if (!isFilePathValid) {
    console.error(`Wallets file at ${filePath} does not exist.`);
    process.exit(1);
  }

  const walletsInfo = JSON.parse(await fs.readFile(filePath, "utf-8"));

  walletsInfo.forEach((w) => {
    if (!w.publicKey || !w.privateKey) {
      console.error(`Invalid wallet ${w} in file ${filePath}`);
      process.exit(1);
    }
  });

  const wallets = walletsInfo.map((w) => {
    return Keypair.fromSecretKey(bs58.decode(w.privateKey));
  });

  return wallets;
}

async function doesFileExist(path) {
  try {
    return (await fs.stat(path)).isFile();
  } catch (e) {
    return false;
  }
}

export function solToLamports(solAmount) {
  return BigInt(solAmount * LAMPORTS_PER_SOL);
}

export function lamportsToSol(amount) {
  return Number(amount) / LAMPORTS_PER_SOL;
}

function chunkArray(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

program.parse();
