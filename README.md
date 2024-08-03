# Solana Batch Wallet Manager

A simple cli utility to batch manage Solana wallets. This is currently very much in progress.

## Installation

```bash
npm install
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

### Get Wallets

```bash
node index.js fund-wallets {wallets_to_fund_json_file} {sol_amount_to_send} {sender_private_key}
```
