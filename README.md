# Solana Batch Wallet Manager

A simple cli utility to batch manage Solana wallets. This is currently very much in progress.

## Installation

```bash
npm install
```

Add a `.env` file to the root of the project with the following:

```bash
RPC_ENDPOINT=https://api.devnet.solana.com
```

## Usage

```bash
node index.js --help
```

## Commands

### Generate Wallets

```bash
node index.js generate-wallets 10 --output wallets.json
```

### Fund Wallets

```bash
node index.js fund-wallets {wallets_to_fund_json_file} {sol_amount_to_send} {sender_private_key}
```
