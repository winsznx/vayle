// Generated from contracts/out/PriceAdapter.sol/PriceAdapter.json by src/generate.ts. Don't edit.
export const priceAdapterAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "registry_",
        "type": "address",
        "internalType": "contract StockTokenRegistry"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "MAX_AGE_AT_CLOSE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "referencePrice",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "close",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "roundHint",
        "type": "uint80",
        "internalType": "uint80"
      },
      {
        "name": "previousReference",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "price",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "roundId",
        "type": "uint80",
        "internalType": "uint80"
      },
      {
        "name": "updatedAt",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "registry",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract StockTokenRegistry"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "error",
    "name": "CloseNotPassed",
    "inputs": [
      {
        "name": "close",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "timestamp",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "FeedDecimalsChanged",
    "inputs": [
      {
        "name": "feed",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "listed",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "current",
        "type": "uint8",
        "internalType": "uint8"
      }
    ]
  },
  {
    "type": "error",
    "name": "FeedUnusable",
    "inputs": [
      {
        "name": "feed",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NonPositivePrice",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint80",
        "internalType": "uint80"
      },
      {
        "name": "answer",
        "type": "int256",
        "internalType": "int256"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotAStockToken",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotLastRoundBeforeClose",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint80",
        "internalType": "uint80"
      },
      {
        "name": "close",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "OraclePaused",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "PriceJump",
    "inputs": [
      {
        "name": "price",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "previousReference",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "RoundAfterClose",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint80",
        "internalType": "uint80"
      },
      {
        "name": "updatedAt",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "close",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "SafeCastOverflowedIntToUint",
    "inputs": [
      {
        "name": "value",
        "type": "int256",
        "internalType": "int256"
      }
    ]
  },
  {
    "type": "error",
    "name": "SafeCastOverflowedUintDowncast",
    "inputs": [
      {
        "name": "bits",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "StaleAtClose",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint80",
        "internalType": "uint80"
      },
      {
        "name": "updatedAt",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "close",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "UnknownRound",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint80",
        "internalType": "uint80"
      }
    ]
  }
] as const;
