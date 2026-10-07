// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {DeployVayle} from "./DeployVayle.s.sol";

/// @notice The production deploy, broadcast to a local anvil fork by `pnpm fork up`. It reads its
/// boundaries from and writes its addresses to deployments/fork/, which git ignores.
/// @dev Nothing else differs. Run against mainnet it reverts MultisigHasNoCode, because the fork's
/// stand-in multisig only has code on the fork.
contract DeployFork is DeployVayle {
    function _boundariesFile() internal pure override returns (string memory) {
        return "fork/calendar-boundaries.json";
    }

    function _recordFile() internal pure override returns (string memory) {
        return "fork/vayle.json";
    }
}
