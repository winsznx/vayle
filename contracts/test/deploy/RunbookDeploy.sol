// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {DeployVayle} from "../../script/DeployVayle.s.sol";

/// @notice The deploy script reading its boundaries from a file of its own, so a test of the
/// runbook's inputs never touches the boundaries the runbook prepares for a real deploy.
contract RunbookDeploy is DeployVayle {
    function _boundariesFile() internal pure override returns (string memory) {
        return "runbook-test-boundaries.json";
    }
}
