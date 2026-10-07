// Generated from contracts/out/SessionCalendar.sol/SessionCalendar.json by src/generate.ts. Don't edit.
export const sessionCalendarAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "initialOwner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "initial",
        "type": "tuple[]",
        "internalType": "struct SessionCalendar.Boundary[]",
        "components": [
          {
            "name": "close",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "creationDeadline",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "MAX_CREATION_DELAY",
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
    "name": "MAX_SPACING",
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
    "name": "MIN_LEAD",
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
    "name": "acceptOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "append",
    "inputs": [
      {
        "name": "boundaries",
        "type": "tuple[]",
        "internalType": "struct SessionCalendar.Boundary[]",
        "components": [
          {
            "name": "close",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "creationDeadline",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "boundaryAt",
    "inputs": [
      {
        "name": "index",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct SessionCalendar.Boundary",
        "components": [
          {
            "name": "close",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "creationDeadline",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "boundaryCount",
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
    "name": "latestBoundaryAtOrBefore",
    "inputs": [
      {
        "name": "timestamp",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct SessionCalendar.Boundary",
        "components": [
          {
            "name": "close",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "creationDeadline",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "nextCloseAfter",
    "inputs": [
      {
        "name": "timestamp",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
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
    "name": "truncate",
    "inputs": [
      {
        "name": "keep",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "BoundariesAppended",
    "inputs": [
      {
        "name": "fromIndex",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "boundaries",
        "type": "tuple[]",
        "indexed": false,
        "internalType": "struct SessionCalendar.Boundary[]",
        "components": [
          {
            "name": "close",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "creationDeadline",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "BoundariesTruncated",
    "inputs": [
      {
        "name": "keep",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "removed",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
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
    "name": "BadCreationDeadline",
    "inputs": [
      {
        "name": "close",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "creationDeadline",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "NoCloseAfter",
    "inputs": [
      {
        "name": "timestamp",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "NoCloseAtOrBefore",
    "inputs": [
      {
        "name": "timestamp",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotASessionClose",
    "inputs": [
      {
        "name": "close",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotIncreasing",
    "inputs": [
      {
        "name": "previous",
        "type": "uint64",
        "internalType": "uint64"
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
    "name": "NothingToTruncate",
    "inputs": [
      {
        "name": "keep",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "length",
        "type": "uint256",
        "internalType": "uint256"
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
    "name": "ProtectedClose",
    "inputs": [
      {
        "name": "close",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "TooFarApart",
    "inputs": [
      {
        "name": "previous",
        "type": "uint64",
        "internalType": "uint64"
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
    "name": "TooSoon",
    "inputs": [
      {
        "name": "close",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "earliest",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  }
] as const;
