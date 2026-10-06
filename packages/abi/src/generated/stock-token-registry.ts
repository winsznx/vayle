// Generated from contracts/out/StockTokenRegistry.sol/StockTokenRegistry.json by src/generate.ts. Don't edit.
export const stockTokenRegistryAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "initialOwner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "usdg_",
        "type": "address",
        "internalType": "contract IERC20Metadata"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "acceptOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "asset",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct StockTokenRegistry.Asset",
        "components": [
          {
            "name": "uid",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "feed",
            "type": "address",
            "internalType": "contract IPriceFeed"
          },
          {
            "name": "decimals",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "feedDecimals",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "rawUnit",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "lot",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "priceTick",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "strikeTick",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "strikeRangeBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "listed",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "delist",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "isListed",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "list",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "uid",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "feed",
        "type": "address",
        "internalType": "contract IPriceFeed"
      },
      {
        "name": "lot",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "priceTick",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "strikeTick",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "strikeRangeBps",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingOwner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "renounceOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "transferOwnership",
    "inputs": [
      {
        "name": "newOwner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "usdg",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IERC20Metadata"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "usdgDecimals",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "AssetDelisted",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "AssetListed",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "uid",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "feed",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "lot",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "priceTick",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "strikeTick",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "strikeRangeBps",
        "type": "uint16",
        "indexed": false,
        "internalType": "uint16"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferStarted",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferred",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AlreadyListed",
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
    "name": "BadStrikeGrid",
    "inputs": [
      {
        "name": "strikeTick",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "priceTick",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "strikeRangeBps",
        "type": "uint16",
        "internalType": "uint16"
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
    "name": "InexactGrid",
    "inputs": [
      {
        "name": "lot",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "priceTick",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "rawUnit",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "InterfaceNotSupported",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "interfaceId",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotAContract",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
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
    "name": "NotListed",
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
    "name": "OwnableInvalidOwner",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "OwnableUnauthorizedAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "UidMismatch",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "expected",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "actual",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  }
] as const;
