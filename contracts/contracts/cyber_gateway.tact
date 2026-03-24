import "@stdlib/deploy";
import "@stdlib/ownable";

// ============================================
// Standard Jetton opcodes (TEP-74)
// ============================================

message(0x7362d09c) JettonTransferNotification {
    query_id: Int as uint64;
    amount: Int as coins;
    sender: Address;
    forward_payload: Slice as remaining;
}

message(0x0f8a7ea5) JettonTransfer {
    query_id: Int as uint64;
    amount: Int as coins;
    destination: Address;
    response_destination: Address;
    custom_payload: Cell?;
    forward_ton_amount: Int as coins;
    forward_payload: Slice as remaining;
}

// ============================================
// CyberGateway Messages
// ============================================

message BatchSettle {
    batch_id: Int as uint64;
    batch_data: Cell;
    tee_signature: Slice as remaining;  // 512 bits
}

message InitiateWithdraw {
    amount: Int as coins;
}

message CompleteWithdraw {}

message SetTeeKey {
    tee_pubkey: Int as uint256;
}

message SetJettonWallet {
    wallet: Address;
}

message SetCooldown {
    seconds: Int as uint32;
}

message SetStopped {
    stopped: Bool;
}

// ── P1: Large payment on-chain signature verification ──

message VerifiedBatchSettle {
    batch_id: Int as uint64;
    batch_data: Cell;
    user_sigs: Cell;          // Cell chain: each cell has 512-bit Ed25519 sig
    tee_signature: Slice as remaining;
}

// ── P3: Delegate mechanism ──

message AddDelegate {
    delegate: Address;
}

message RemoveDelegate {
    delegate: Address;
}

message RegisterPubkey {
    pubkey: Int as uint256;
}

message RescueJetton {
    jetton_wallet: Address;
    amount: Int as coins;
}

// ── Spending Limit & Daily Cap Messages ──

message SetSpendingLimit {
    depositor: Address;
    limit: Int as coins;
}

message SetDailyCap {
    depositor: Address;
    cap: Int as coins;
}

message SetSelfSpendingLimit {
    limit: Int as coins;
}

message SetSelfDailyCap {
    cap: Int as coins;
}

// ── HITL Approval Messages ──

message RequestApproval {
    payment_id: Int as uint64;
    from: Address;
    to: Address;
    amount: Int as coins;
}

message ApprovePayment {
    payment_id: Int as uint64;
}

message RejectPayment {
    payment_id: Int as uint64;
}

// ============================================
// Events
// ============================================

struct DepositEvent {
    depositor: Address;
    amount: Int as coins;
    new_balance: Int as coins;
}

struct BatchSettleEvent {
    batch_id: Int as uint64;
    count: Int as uint16;
    total_amount: Int as coins;
    batch_data_hash: Int as uint256;
}

struct VerifiedBatchSettleEvent {
    batch_id: Int as uint64;
    count: Int as uint16;
    total_amount: Int as coins;
    batch_data_hash: Int as uint256;
    verified_count: Int as uint16;
}

struct WithdrawInitiatedEvent {
    depositor: Address;
    amount: Int as coins;
    available_at: Int as uint64;
}

struct WithdrawCompletedEvent {
    depositor: Address;
    amount: Int as coins;
}

struct SpendingLimitSetEvent {
    depositor: Address;
    limit: Int as coins;
}

struct DailyCapSetEvent {
    depositor: Address;
    cap: Int as coins;
}

struct ApprovalRequestedEvent {
    payment_id: Int as uint64;
    from: Address;
    to: Address;
    amount: Int as coins;
}

struct PaymentApprovedEvent {
    payment_id: Int as uint64;
}

struct PaymentRejectedEvent {
    payment_id: Int as uint64;
    from: Address;
    amount: Int as coins;
}

struct DelegateAddedEvent {
    depositor: Address;
    delegate: Address;
}

struct DelegateRemovedEvent {
    depositor: Address;
    delegate: Address;
}

// ============================================
// CyberGateway Contract
// ============================================

contract CyberGateway with Deployable, Ownable, OwnableTransferable {
    owner: Address;
    stopped: Bool;
    tee_pubkey: Int as uint256;
    jetton_wallet: Address?;

    // ── Core balances ──
    balances: map<Address, Int>;
    withdraw_amounts: map<Address, Int>;
    withdraw_times: map<Address, Int>;
    withdrawal_cooldown: Int as uint32;
    settled_batches: map<Int, Bool>;
    total_deposits: Int as coins;
    total_settled: Int as coins;
    total_withdrawn: Int as coins;

    // ── Spending limits (per-depositor, 0 = unlimited) ──
    spending_limits: map<Address, Int>;
    daily_caps: map<Address, Int>;
    daily_spent: map<Address, Int>;
    daily_reset_time: map<Address, Int>;

    // ── HITL pending approvals ──
    pending_from: map<Int, Address>;
    pending_to: map<Int, Address>;
    pending_amount: map<Int, Int>;
    next_payment_id: Int as uint64;

    // ── P3: Delegate mechanism (depositor → delegate → authorized) ──
    delegates: map<Address, Address>;  // flat: depositor → single delegate (use Cell for multi)

    // ── P1: User public keys for on-chain signature verification ──
    user_pubkeys: map<Address, Int>;   // address → Ed25519 pubkey (uint256)

    const MIN_BALANCE: Int = ton("0.05");
    const GAS_CONSUMPTION: Int = ton("0.05");
    const SECONDS_PER_DAY: Int = 86400;

    init(owner: Address, tee_pubkey: Int) {
        self.owner = owner;
        self.tee_pubkey = tee_pubkey;
        self.stopped = false;
        self.withdrawal_cooldown = 86400;
        self.total_deposits = 0;
        self.total_settled = 0;
        self.total_withdrawn = 0;
        self.next_payment_id = 1;
    }

    // ── Helper: get balance with default 0 ──
    fun _bal(addr: Address): Int {
        let v: Int? = self.balances.get(addr);
        if (v != null) {
            return v!!;
        }
        return 0;
    }

    // ── Helper: get map value with default 0 ──
    fun _getOrZero(m: map<Address, Int>, addr: Address): Int {
        let v: Int? = m.get(addr);
        if (v != null) {
            return v!!;
        }
        return 0;
    }

    // ── Helper: check and reset daily counter if new day ──
    fun _resetDailyIfNeeded(addr: Address) {
        let resetTime: Int = self._getOrZero(self.daily_reset_time, addr);
        if (now() >= resetTime) {
            self.daily_spent.set(addr, 0);
            self.daily_reset_time.set(addr, now() + self.SECONDS_PER_DAY);
        }
    }

    // ============================================
    // Deposit: receive USDT Jetton
    // ============================================

    receive(msg: JettonTransferNotification) {
        require(!self.stopped, "Contract is stopped");

        let ctx: Context = context();
        nativeReserve(max(self.MIN_BALANCE, myBalance() - ctx.value), 0);

        let payload: Slice = msg.forward_payload;
        let op: Int = 0;

        if (payload.bits() >= 1) {
            let eitherBit: Int = payload.loadUint(1);
            if (eitherBit == 1 && payload.refs() > 0) {
                payload = payload.loadRef().beginParse();
            }
            if (payload.bits() >= 8) {
                op = payload.loadUint(8);
            }
        }

        if (op == 0 || op == 2) {
            self._processDeposit(msg.sender, msg.amount);
        }
    }

    fun _processDeposit(depositor: Address, amount: Int) {
        let current: Int = self._bal(depositor);
        let new_balance: Int = current + amount;
        self.balances.set(depositor, new_balance);
        self.total_deposits = self.total_deposits + amount;

        emit(DepositEvent{
            depositor: depositor,
            amount: amount,
            new_balance: new_balance
        }.toCell());
    }

    // ============================================
    // BatchSettle: TEE submits batch of transfers
    // Now enforces spending_limit and daily_cap
    // ============================================

    receive(msg: BatchSettle) {
        require(!self.stopped, "Contract is stopped");
        require(self.settled_batches.get(msg.batch_id) == null, "Batch already settled");

        // Verify TEE Ed25519 signature
        let data_hash: Int = msg.batch_data.hash();
        let signature: Slice = beginCell()
            .storeSlice(msg.tee_signature)
            .endCell()
            .beginParse();

        require(
            checkSignature(data_hash, signature, self.tee_pubkey),
            "Invalid TEE signature"
        );

        // Parse batch_data
        let batch: Slice = msg.batch_data.beginParse();
        let count: Int = batch.loadUint(16);
        require(count > 0, "Empty batch");
        require(count <= 255, "Batch too large");

        let total_amount: Int = 0;
        let i: Int = 0;

        while (i < count) {
            if (batch.refs() > 0 && batch.bits() < 267 + 267 + 4) {
                batch = batch.loadRef().beginParse();
            }

            let from: Address = batch.loadAddress();
            let to: Address = batch.loadAddress();
            let amount: Int = batch.loadCoins();

            let sender_balance: Int = self._bal(from);
            require(sender_balance >= amount, "Insufficient balance in batch");

            // ── Enforce spending limit ──
            let limit: Int = self._getOrZero(self.spending_limits, from);
            if (limit > 0) {
                require(amount <= limit, "Exceeds spending limit");
            }

            // ── Enforce daily cap ──
            self._resetDailyIfNeeded(from);
            let cap: Int = self._getOrZero(self.daily_caps, from);
            if (cap > 0) {
                let spent: Int = self._getOrZero(self.daily_spent, from);
                require(spent + amount <= cap, "Exceeds daily cap");
                self.daily_spent.set(from, spent + amount);
            }

            self.balances.set(from, sender_balance - amount);

            let receiver_balance: Int = self._bal(to);
            self.balances.set(to, receiver_balance + amount);

            total_amount = total_amount + amount;
            i = i + 1;
        }

        self.settled_batches.set(msg.batch_id, true);
        self.total_settled = self.total_settled + total_amount;

        emit(BatchSettleEvent{
            batch_id: msg.batch_id,
            count: count,
            total_amount: total_amount,
            batch_data_hash: data_hash
        }.toCell());

        send(SendParameters{
            to: sender(),
            value: 0,
            mode: SendRemainingValue + SendIgnoreErrors,
            bounce: false
        });
    }

    // ============================================
    // P1: VerifiedBatchSettle — large payments with user Ed25519 sigs
    // TEE submits batch + per-item user signatures verified on-chain
    // ============================================

    receive(msg: VerifiedBatchSettle) {
        require(!self.stopped, "Contract is stopped");
        require(self.settled_batches.get(msg.batch_id) == null, "Batch already settled");

        // Verify TEE signature over batch_data
        let data_hash: Int = msg.batch_data.hash();
        let tee_sig: Slice = beginCell()
            .storeSlice(msg.tee_signature)
            .endCell()
            .beginParse();

        require(
            checkSignature(data_hash, tee_sig, self.tee_pubkey),
            "Invalid TEE signature"
        );

        // Parse batch_data
        let batch: Slice = msg.batch_data.beginParse();
        let count: Int = batch.loadUint(16);
        require(count > 0, "Empty batch");
        require(count <= 100, "Verified batch too large");

        // Parse user signatures cell chain
        let sigs: Slice = msg.user_sigs.beginParse();

        let total_amount: Int = 0;
        let verified_count: Int = 0;
        let i: Int = 0;

        while (i < count) {
            if (batch.refs() > 0 && batch.bits() < 267 + 267 + 4) {
                batch = batch.loadRef().beginParse();
            }

            let from: Address = batch.loadAddress();
            let to: Address = batch.loadAddress();
            let amount: Int = batch.loadCoins();

            // Load user signature (512 bits)
            if (sigs.bits() < 512 && sigs.refs() > 0) {
                sigs = sigs.loadRef().beginParse();
            }
            let user_sig: Slice = beginCell()
                .storeUint(sigs.loadUint(256), 256)
                .storeUint(sigs.loadUint(256), 256)
                .endCell()
                .beginParse();

            // Verify user's Ed25519 signature over the item data
            let user_pubkey: Int? = self.user_pubkeys.get(from);
            require(user_pubkey != null, "User pubkey not registered");

            // Item hash = hash of (from, to, amount, batch_id)
            let item_cell: Cell = beginCell()
                .storeAddress(from)
                .storeAddress(to)
                .storeCoins(amount)
                .storeUint(msg.batch_id, 64)
                .endCell();
            let item_hash: Int = item_cell.hash();

            require(
                checkSignature(item_hash, user_sig, user_pubkey!!),
                "Invalid user signature"
            );
            verified_count = verified_count + 1;

            // Execute transfer
            let sender_balance: Int = self._bal(from);
            require(sender_balance >= amount, "Insufficient balance");

            self.balances.set(from, sender_balance - amount);
            let receiver_balance: Int = self._bal(to);
            self.balances.set(to, receiver_balance + amount);

            total_amount = total_amount + amount;
            i = i + 1;
        }

        self.settled_batches.set(msg.batch_id, true);
        self.total_settled = self.total_settled + total_amount;

        emit(VerifiedBatchSettleEvent{
            batch_id: msg.batch_id,
            count: count,
            total_amount: total_amount,
            batch_data_hash: data_hash,
            verified_count: verified_count
        }.toCell());

        send(SendParameters{
            to: sender(),
            value: 0,
            mode: SendRemainingValue + SendIgnoreErrors,
            bounce: false
        });
    }

    // ============================================
    // P1: Register user public key for on-chain verification
    // ============================================

    receive(msg: RegisterPubkey) {
        let caller: Address = sender();
        self.user_pubkeys.set(caller, msg.pubkey);
        send(SendParameters{
            to: caller, value: 0,
            mode: SendRemainingValue + SendIgnoreErrors, bounce: false
        });
    }

    // ============================================
    // P3: Delegate mechanism
    // Depositor authorizes another address to spend on their behalf
    // ============================================

    receive(msg: AddDelegate) {
        let caller: Address = sender();
        self.delegates.set(caller, msg.delegate);

        emit(DelegateAddedEvent{
            depositor: caller,
            delegate: msg.delegate
        }.toCell());

        send(SendParameters{
            to: caller, value: 0,
            mode: SendRemainingValue + SendIgnoreErrors, bounce: false
        });
    }

    receive(msg: RemoveDelegate) {
        let caller: Address = sender();
        let current: Address? = self.delegates.get(caller);
        require(current != null, "No delegate set");
        self.delegates.set(caller, null);

        emit(DelegateRemovedEvent{
            depositor: caller,
            delegate: msg.delegate
        }.toCell());

        send(SendParameters{
            to: caller, value: 0,
            mode: SendRemainingValue + SendIgnoreErrors, bounce: false
        });
    }

    // ============================================
    // Withdraw: two-phase withdrawal
    // ============================================

    receive(msg: InitiateWithdraw) {
        require(!self.stopped, "Contract is stopped");
        let caller: Address = sender();

        let balance: Int = self._bal(caller);
        require(balance >= msg.amount, "Insufficient balance");
        require(msg.amount > 0, "Zero amount");
        require(self.withdraw_amounts.get(caller) == null, "Withdrawal already pending");

        self.balances.set(caller, balance - msg.amount);
        self.withdraw_amounts.set(caller, msg.amount);
        self.withdraw_times.set(caller, now() + self.withdrawal_cooldown);

        emit(WithdrawInitiatedEvent{
            depositor: caller,
            amount: msg.amount,
            available_at: now() + self.withdrawal_cooldown
        }.toCell());

        send(SendParameters{
            to: caller,
            value: 0,
            mode: SendRemainingValue + SendIgnoreErrors,
            bounce: false
        });
    }

    receive(msg: CompleteWithdraw) {
        require(!self.stopped, "Contract is stopped");
        let caller: Address = sender();

        let amt: Int? = self.withdraw_amounts.get(caller);
        require(amt != null, "No pending withdrawal");
        let amount: Int = amt!!;
        require(amount > 0, "No pending withdrawal");

        let avail: Int? = self.withdraw_times.get(caller);
        require(avail != null, "No pending withdrawal");
        require(now() >= avail!!, "Cooldown not elapsed");

        self.withdraw_amounts.set(caller, null);
        self.withdraw_times.set(caller, null);

        let jetton_wallet: Address = self.jetton_wallet!!;
        let emptyFwd: Slice = beginCell().storeUint(0, 1).endCell().beginParse();

        send(SendParameters{
            to: jetton_wallet,
            value: self.GAS_CONSUMPTION,
            mode: SendPayGasSeparately | SendIgnoreErrors,
            body: JettonTransfer{
                query_id: 0,
                amount: amount,
                destination: caller,
                response_destination: caller,
                custom_payload: null,
                forward_ton_amount: 0,
                forward_payload: emptyFwd
            }.toCell()
        });

        self.total_withdrawn = self.total_withdrawn + amount;

        emit(WithdrawCompletedEvent{
            depositor: caller,
            amount: amount
        }.toCell());
    }

    // ============================================
    // Spending Limits & Daily Caps
    // ============================================

    // Owner sets limit for any depositor
    receive(msg: SetSpendingLimit) {
        self.requireOwner();
        self.spending_limits.set(msg.depositor, msg.limit);
        emit(SpendingLimitSetEvent{
            depositor: msg.depositor,
            limit: msg.limit
        }.toCell());
        send(SendParameters{
            to: sender(), value: 0,
            mode: SendRemainingValue + SendIgnoreErrors, bounce: false
        });
    }

    receive(msg: SetDailyCap) {
        self.requireOwner();
        self.daily_caps.set(msg.depositor, msg.cap);
        emit(DailyCapSetEvent{
            depositor: msg.depositor,
            cap: msg.cap
        }.toCell());
        send(SendParameters{
            to: sender(), value: 0,
            mode: SendRemainingValue + SendIgnoreErrors, bounce: false
        });
    }

    // Self-service: depositor sets their own limits (can only lower, not raise above owner-set)
    receive(msg: SetSelfSpendingLimit) {
        let caller: Address = sender();
        let current: Int = self._getOrZero(self.spending_limits, caller);
        // Can only set if no limit exists, or new limit is lower
        if (current > 0) {
            require(msg.limit <= current, "Can only lower spending limit");
        }
        require(msg.limit > 0, "Limit must be positive");
        self.spending_limits.set(caller, msg.limit);
        emit(SpendingLimitSetEvent{
            depositor: caller,
            limit: msg.limit
        }.toCell());
        send(SendParameters{
            to: caller, value: 0,
            mode: SendRemainingValue + SendIgnoreErrors, bounce: false
        });
    }

    receive(msg: SetSelfDailyCap) {
        let caller: Address = sender();
        let current: Int = self._getOrZero(self.daily_caps, caller);
        if (current > 0) {
            require(msg.cap <= current, "Can only lower daily cap");
        }
        require(msg.cap > 0, "Cap must be positive");
        self.daily_caps.set(caller, msg.cap);
        emit(DailyCapSetEvent{
            depositor: caller,
            cap: msg.cap
        }.toCell());
        send(SendParameters{
            to: caller, value: 0,
            mode: SendRemainingValue + SendIgnoreErrors, bounce: false
        });
    }

    // ============================================
    // HITL: Pending Approval (TEE requests, human approves)
    // ============================================

    // TEE requests approval for a large payment (via owner wallet)
    receive(msg: RequestApproval) {
        // Only TEE (via owner wallet) can request approvals
        self.requireOwner();
        let pid: Int = msg.payment_id;
        self.pending_from.set(pid, msg.from);
        self.pending_to.set(pid, msg.to);
        self.pending_amount.set(pid, msg.amount);

        emit(ApprovalRequestedEvent{
            payment_id: pid,
            from: msg.from,
            to: msg.to,
            amount: msg.amount
        }.toCell());

        send(SendParameters{
            to: sender(), value: 0,
            mode: SendRemainingValue + SendIgnoreErrors, bounce: false
        });
    }

    // Human approves — funds are transferred
    receive(msg: ApprovePayment) {
        self.requireOwner();
        let pid: Int = msg.payment_id;

        let fromAddr: Address? = self.pending_from.get(pid);
        require(fromAddr != null, "No pending approval");
        let from: Address = fromAddr!!;

        let toAddr: Address? = self.pending_to.get(pid);
        require(toAddr != null, "No pending approval");
        let to: Address = toAddr!!;

        let amtVal: Int? = self.pending_amount.get(pid);
        require(amtVal != null, "No pending approval");
        let amount: Int = amtVal!!;

        // Execute the transfer
        let sender_balance: Int = self._bal(from);
        require(sender_balance >= amount, "Insufficient balance");
        self.balances.set(from, sender_balance - amount);

        let receiver_balance: Int = self._bal(to);
        self.balances.set(to, receiver_balance + amount);

        // Clean up
        self.pending_from.set(pid, null);
        self.pending_to.set(pid, null);
        self.pending_amount.set(pid, null);

        emit(PaymentApprovedEvent{ payment_id: pid }.toCell());

        send(SendParameters{
            to: sender(), value: 0,
            mode: SendRemainingValue + SendIgnoreErrors, bounce: false
        });
    }

    // Human rejects — funds returned to sender's available balance
    receive(msg: RejectPayment) {
        self.requireOwner();
        let pid: Int = msg.payment_id;

        let fromAddr: Address? = self.pending_from.get(pid);
        require(fromAddr != null, "No pending approval");
        let from: Address = fromAddr!!;

        let amtVal: Int? = self.pending_amount.get(pid);
        require(amtVal != null, "No pending approval");
        let amount: Int = amtVal!!;

        // Clean up
        self.pending_from.set(pid, null);
        self.pending_to.set(pid, null);
        self.pending_amount.set(pid, null);

        emit(PaymentRejectedEvent{
            payment_id: pid,
            from: from,
            amount: amount
        }.toCell());

        send(SendParameters{
            to: sender(), value: 0,
            mode: SendRemainingValue + SendIgnoreErrors, bounce: false
        });
    }

    // ============================================
    // Admin functions
    // ============================================

    receive(msg: SetTeeKey) {
        self.requireOwner();
        self.tee_pubkey = msg.tee_pubkey;
        send(SendParameters{
            to: sender(), value: 0,
            mode: SendRemainingValue + SendIgnoreErrors, bounce: false
        });
    }

    receive(msg: SetJettonWallet) {
        self.requireOwner();
        self.jetton_wallet = msg.wallet;
        send(SendParameters{
            to: sender(), value: 0,
            mode: SendRemainingValue + SendIgnoreErrors, bounce: false
        });
    }

    receive(msg: SetCooldown) {
        self.requireOwner();
        self.withdrawal_cooldown = msg.seconds;
        send(SendParameters{
            to: sender(), value: 0,
            mode: SendRemainingValue + SendIgnoreErrors, bounce: false
        });
    }

    receive(msg: SetStopped) {
        self.requireOwner();
        self.stopped = msg.stopped;
        send(SendParameters{
            to: sender(), value: 0,
            mode: SendRemainingValue + SendIgnoreErrors, bounce: false
        });
    }

    receive(msg: RescueJetton) {
        self.requireOwner();
        let emptyFwd: Slice = beginCell().storeUint(0, 1).endCell().beginParse();
        send(SendParameters{
            to: msg.jetton_wallet,
            value: self.GAS_CONSUMPTION,
            mode: SendPayGasSeparately | SendIgnoreErrors,
            body: JettonTransfer{
                query_id: 0,
                amount: msg.amount,
                destination: self.owner,
                response_destination: self.owner,
                custom_payload: null,
                forward_ton_amount: 0,
                forward_payload: emptyFwd
            }.toCell()
        });
    }

    // ============================================
    // Getters
    // ============================================

    get fun balance(addr: Address): Int {
        return self._bal(addr);
    }

    get fun pendingWithdrawal(addr: Address): Int {
        let v: Int? = self.withdraw_amounts.get(addr);
        if (v != null) { return v!!; }
        return 0;
    }

    get fun withdrawAvailableAt(addr: Address): Int {
        let v: Int? = self.withdraw_times.get(addr);
        if (v != null) { return v!!; }
        return 0;
    }

    get fun teePublicKey(): Int {
        return self.tee_pubkey;
    }

    get fun stopped(): Bool {
        return self.stopped;
    }

    get fun stats(): map<Int, Int> {
        let m: map<Int, Int> = emptyMap();
        m.set(0, self.total_deposits);
        m.set(1, self.total_settled);
        m.set(2, self.total_withdrawn);
        return m;
    }

    get fun isBatchSettled(batch_id: Int): Bool {
        return self.settled_batches.get(batch_id) == true;
    }

    get fun cooldown(): Int {
        return self.withdrawal_cooldown;
    }

    get fun spendingLimit(addr: Address): Int {
        return self._getOrZero(self.spending_limits, addr);
    }

    get fun dailyCap(addr: Address): Int {
        return self._getOrZero(self.daily_caps, addr);
    }

    get fun dailySpent(addr: Address): Int {
        return self._getOrZero(self.daily_spent, addr);
    }

    get fun pendingApproval(payment_id: Int): Int {
        let v: Int? = self.pending_amount.get(payment_id);
        if (v != null) { return v!!; }
        return 0;
    }

    get fun delegate(addr: Address): Address? {
        return self.delegates.get(addr);
    }

    get fun userPubkey(addr: Address): Int {
        let v: Int? = self.user_pubkeys.get(addr);
        if (v != null) { return v!!; }
        return 0;
    }
}
