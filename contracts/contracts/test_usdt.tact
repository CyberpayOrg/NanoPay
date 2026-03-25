import "@stdlib/ownable";

// ============================================
// TEP-74 Jetton Standard Messages
// ============================================

message(0xf8a7ea5) TokenTransfer {
    queryId: Int as uint64;
    amount: Int as coins;
    destination: Address;
    response_destination: Address;
    custom_payload: Cell?;
    forward_ton_amount: Int as coins;
    forward_payload: Slice as remaining;
}

message(0x178d4519) TokenTransferInternal {
    queryId: Int as uint64;
    amount: Int as coins;
    from: Address;
    response_destination: Address;
    forward_ton_amount: Int as coins;
    forward_payload: Slice as remaining;
}

message(0x7362d09c) TokenNotification {
    queryId: Int as uint64;
    amount: Int as coins;
    from: Address;
    forward_payload: Slice as remaining;
}

message(0x595f07bc) TokenBurn {
    queryId: Int as uint64;
    amount: Int as coins;
    owner: Address;
    response_destination: Address;
}

message(0x7bdd97de) TokenBurnNotification {
    queryId: Int as uint64;
    amount: Int as coins;
    owner: Address;
    response_destination: Address?;
}

message(0xd53276db) TokenExcesses {
    queryId: Int as uint64;
}

message TokenUpdateContent {
    content: Cell;
}

// ============================================
// Mint message
// ============================================

message Mint {
    to: Address;
    amount: Int as coins;
}

// ============================================
// TestUSDT — Jetton Master (Minter)
// ============================================

contract TestUSDT with Ownable {
    totalSupply: Int as coins;
    owner: Address;
    content: Cell;

    init(owner: Address, content: Cell) {
        self.totalSupply = 0;
        self.owner = owner;
        self.content = content;
    }

    // Only owner can mint
    receive(msg: Mint) {
        self.requireOwner();
        self.totalSupply = self.totalSupply + msg.amount;

        let winit: StateInit = initOf TestUSDTWallet(myAddress(), msg.to);
        send(SendParameters{
            to: contractAddress(winit),
            value: 0,
            bounce: false,
            mode: SendRemainingValue,
            body: TokenTransferInternal{
                queryId: 0,
                amount: msg.amount,
                from: myAddress(),
                response_destination: self.owner,
                forward_ton_amount: 0,
                forward_payload: emptySlice()
            }.toCell(),
            code: winit.code,
            data: winit.data
        });
    }

    receive(msg: TokenBurnNotification) {
        let winit: StateInit = initOf TestUSDTWallet(myAddress(), msg.owner);
        require(contractAddress(winit) == sender(), "Invalid sender");
        self.totalSupply = self.totalSupply - msg.amount;
        if (msg.response_destination != null) {
            send(SendParameters{
                to: msg.response_destination!!,
                value: 0, bounce: false,
                mode: SendRemainingValue + SendIgnoreErrors,
                body: TokenExcesses{ queryId: msg.queryId }.toCell()
            });
        }
    }

    receive(msg: TokenUpdateContent) {
        self.requireOwner();
        self.content = msg.content;
    }

    fun getJettonWalletInit(owner: Address): StateInit {
        return initOf TestUSDTWallet(myAddress(), owner);
    }

    get fun get_jetton_data(): JettonMasterData {
        return JettonMasterData{
            totalSupply: self.totalSupply,
            mintable: true,
            owner: self.owner,
            content: self.content,
            walletCode: self.getJettonWalletInit(myAddress()).code
        };
    }

    get fun get_wallet_address(owner: Address): Address {
        return contractAddress(self.getJettonWalletInit(owner));
    }
}

struct JettonMasterData {
    totalSupply: Int;
    mintable: Bool;
    owner: Address;
    content: Cell;
    walletCode: Cell;
}

// ============================================
// TestUSDTWallet — Jetton Wallet
// ============================================

contract TestUSDTWallet {
    const minTonsForStorage: Int = ton("0.01");
    const gasConsumption: Int = ton("0.01");

    balance: Int as coins;
    owner: Address;
    master: Address;

    init(master: Address, owner: Address) {
        self.balance = 0;
        self.owner = owner;
        self.master = master;
    }

    receive(msg: TokenTransfer) {
        require(sender() == self.owner, "Invalid sender");

        let ctx: Context = context();
        let fwdFee: Int = ctx.readForwardFee() + ctx.readForwardFee();
        let minValue: Int = 2 * self.gasConsumption + self.minTonsForStorage + fwdFee;
        require(ctx.value > min(minValue, ton("0.01")), "Insufficient value");

        self.balance = self.balance - msg.amount;
        require(self.balance >= 0, "Insufficient balance");

        let init: StateInit = initOf TestUSDTWallet(self.master, msg.destination);
        send(SendParameters{
            to: contractAddress(init),
            value: 0,
            mode: SendRemainingValue,
            bounce: false,
            body: TokenTransferInternal{
                queryId: msg.queryId,
                amount: msg.amount,
                from: self.owner,
                response_destination: msg.response_destination,
                forward_ton_amount: msg.forward_ton_amount,
                forward_payload: msg.forward_payload
            }.toCell(),
            code: init.code,
            data: init.data
        });
    }

    receive(msg: TokenTransferInternal) {
        let ctx: Context = context();
        if (ctx.sender != self.master) {
            let sinit: StateInit = initOf TestUSDTWallet(self.master, msg.from);
            require(contractAddress(sinit) == ctx.sender, "Invalid sender");
        }

        self.balance = self.balance + msg.amount;
        require(self.balance >= 0, "Invalid balance");

        let msgValue: Int = ctx.value;
        let tonBalanceBefore: Int = myBalance() - msgValue;
        let storageFee: Int = self.minTonsForStorage - min(tonBalanceBefore, self.minTonsForStorage);
        msgValue = msgValue - storageFee - self.gasConsumption;

        if (msg.forward_ton_amount > 0) {
            send(SendParameters{
                to: self.owner,
                value: msg.forward_ton_amount,
                mode: SendPayGasSeparately + SendIgnoreErrors,
                bounce: false,
                body: TokenNotification{
                    queryId: msg.queryId,
                    amount: msg.amount,
                    from: msg.from,
                    forward_payload: msg.forward_payload
                }.toCell()
            });
        }

        if (msg.response_destination != newAddress(0, 0)) {
            send(SendParameters{
                to: msg.response_destination,
                value: msgValue - msg.forward_ton_amount,
                bounce: false,
                body: TokenExcesses{ queryId: msg.queryId }.toCell(),
                mode: SendIgnoreErrors
            });
        }
    }

    receive(msg: TokenBurn) {
        require(sender() == self.owner, "Invalid sender");
        self.balance = self.balance - msg.amount;
        require(self.balance >= 0, "Insufficient balance");

        send(SendParameters{
            to: self.master,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: TokenBurnNotification{
                queryId: msg.queryId,
                amount: msg.amount,
                owner: self.owner,
                response_destination: self.owner
            }.toCell()
        });
    }

    bounced(src: bounced<TokenTransferInternal>) {
        self.balance = self.balance + src.amount;
    }

    get fun get_wallet_data(): JettonWalletData {
        return JettonWalletData{
            balance: self.balance,
            owner: self.owner,
            master: self.master,
            walletCode: initOf TestUSDTWallet(self.master, self.owner).code
        };
    }
}

struct JettonWalletData {
    balance: Int;
    owner: Address;
    master: Address;
    walletCode: Cell;
}
