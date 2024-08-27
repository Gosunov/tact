import { toNano } from "@ton/core";
import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { RandomContract } from "./contracts/output/random_RandomContract";
import "@ton/test-utils";

describe("random", () => {
    let blockchain: Blockchain;
    let treasure: SandboxContract<TreasuryContract>;
    let contract: SandboxContract<RandomContract>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        treasure = await blockchain.treasury("treasure");

        contract = blockchain.openContract(await RandomContract.fromInit());

        const deployResult = await contract.send(
            treasure.getSender(),
            { value: toNano("10") },
            { $$type: "Deploy", queryId: 0n },
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: treasure.address,
            to: contract.address,
            success: true,
            deploy: true,
        });
    });

    it("should implement random correctly", async () => {
        // Check random values
        // NOTE: These values are generated by the emulator and are deterministic.
        //       They also ensure that `randomize_lt` was called, as without it,
        //       the values would differ.
        expect(await contract.getRandomInt()).toBe(
            12029244659758160506229899028078921673473662712472979861368849515350569944843n,
        );
        expect(await contract.getRandom(0n, 10000n)).toBe(1038n);
    });
});
