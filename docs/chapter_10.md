# Stateful Testing Tutorial

The [Quickstart Tutorial](chapter_7.md) checks one function at a time. Many contract rules depend on earlier calls instead: a withdrawal needs a deposit, and a fee only matters after an admin turns it on. This tutorial uses the `vault` contract from the [example project](chapter_8.md) to show how to test such rules with Rendezvous.

## What You'll Learn

You'll learn to:

- Write an invariant that compares the STX a contract holds with what its ledger records
- Write property-based tests that depend on state created by earlier calls
- Read the execution statistics to see what a run actually exercised
- Catch a bug that only appears after an admin changes a setting

## Prerequisites

Clone the Rendezvous repository and make the `rv` command available, as described in [Development/Contribution Installation](chapter_5.md#developmentcontribution-installation). Run all commands in this tutorial from the `example` directory:

```bash
cd example
```

## The Vault Contract

Open `contracts/vault.clar`. The vault has three public functions:

- `deposit` moves STX from the caller into the vault and adds the amount to the caller's balance.
- `withdraw` subtracts an amount from the caller's balance and pays it out, minus a withdrawal fee. The fee stays in the vault.
- `set-fee` lets the admin (the deployer) set the fee in basis points, up to 10%. The fee starts at zero.

The vault also keeps two totals: `total-balances`, the sum of all user balances, and `total-fees`, the fees it has kept. Here is `withdraw`:

```clarity
(define-public (withdraw (amount uint))
  (let (
      (recipient tx-sender)
      (balance (get-balance recipient))
      (fee (get-fee amount))
    )
    (asserts! (> amount u0) ERR_ZERO_AMOUNT)
    (asserts! (<= amount balance) ERR_INSUFFICIENT_BALANCE)
    ;; The following line pays out the amount minus the fee. Comment it out
    ;; and uncomment the next line to introduce the bug from the tutorial.
    (try! (as-contract (stx-transfer? (- amount fee) tx-sender recipient)))
    ;; (try! (as-contract (stx-transfer? amount tx-sender recipient)))
    (map-set balances recipient (- balance amount))
    (var-set total-balances (- (var-get total-balances) amount))
    (var-set total-fees (+ (var-get total-fees) fee))
    (ok (- amount fee))
  )
)
```

The test functions at the end of the file are annotated with `#[env(simnet)]`, so they are only deployed for testing.

## Step 1: Check the Accounting Rule with an Invariant

The most important rule of the vault connects the STX it holds to its ledger:

> The STX held by the vault equals the sum of user balances plus the fees it has kept.

The vault checks this rule with an invariant:

```clarity
;; #[env(simnet)]
;; The STX held by the vault must match what it owes its users plus the fees
;; it has kept.
(define-read-only (invariant-holdings-match-ledger)
  (is-eq (stx-get-balance VAULT)
    (+ (var-get total-balances) (var-get total-fees))
  )
)
```

During invariant testing, Rendezvous calls random public functions with random arguments and callers, and then checks an invariant. Invariant testing also needs the Rendezvous context, which the vault includes (see [The Rendezvous Context](chapter_6.md#the-rendezvous-context)). This invariant doesn't read the context, because the vault already tracks the totals it needs.

Run invariant testing with a fixed seed:

```bash
rv . vault invariant --seed=7
```

The output starts like this:

```
-------------------------------------------------------------------------------
Using manifest path: Clarinet.toml
Target contract: vault
Using seed: 7
-------------------------------------------------------------------------------

Starting fresh round of invariant testing for the vault contract using user-provided configuration...

₿        5 Ӿ       11   wallet_4        vault deposit u25 (ok true)
₿        5 Ӿ       12   wallet_6        vault set-fee u3 (err u100)
₿        5 Ӿ       12   wallet_6 [PASS] vault invariant-holdings-match-ledger  true
₿       66 Ӿ       74   wallet_1        vault set-fee u94711594 (err u100)
...
```

And it ends with a summary:

```
OK, invariants passed after 100 runs.


EXECUTION STATISTICS

│ PUBLIC FUNCTION CALLS
│
├─ + SUCCESSFUL
│    ├─ deposit: x198
│    ├─ set-fee: x9
│    └─ withdraw: x157
│
├─ - IGNORED
│    ├─ deposit: x0
│    ├─ set-fee: x225
│    └─ withdraw: x41
│
│ INVARIANT CHECKS
│
├─ + PASSED
│    └─ invariant-holdings-match-ledger: x100
│
└─ - FAILED
     └─ invariant-holdings-match-ledger: x0
```

The invariant held in all 100 runs. Before you rely on that, read the statistics. `set-fee` succeeded only 9 times out of 234 calls. Most calls came from accounts other than the admin, or asked for a fee above the limit, so the vault rejected them. Rendezvous counts rejected calls as `IGNORED`. They are expected here, but if an important function never succeeds, the invariant never checks the state after it.

> **Note:** Your output can differ from the output shown in this tutorial. The seed fixes which functions Rendezvous calls and with which arguments. The callers are picked from the accounts that the Clarinet SDK reports, and that list's order can change, for example after you edit a contract or when Clarinet generates a new deployment plan. With different callers, a run with the same seed can take a different path.

## Step 2: Test Functions That Need Earlier State

A property-based test is a private function whose name starts with `test-`. Its result tells Rendezvous what happened:

- `(ok true)`: the property held. Rendezvous reports `PASS`.
- `(ok false)`: the test discarded its input, because the property doesn't apply to it. Rendezvous reports `WARN` and counts the test as discarded. A discarded test checks nothing.
- `(err ...)`: the property failed. Rendezvous reports `FAIL`.

Rendezvous keeps the contract state between test calls instead of resetting it, so a test can rely on state that other tests created. The vault has three property-based tests:

- `test-deposit` deposits a generated amount and checks that the caller's balance grew by that amount.
- `test-set-fee` checks that only the admin can change the fee.
- `test-withdraw` checks that a withdrawal reduces the caller's balance by the amount and pays out the amount minus the fee.

`test-withdraw` needs an earlier deposit by the same caller:

```clarity
(define-private (test-withdraw (amount uint))
  (let ((balance-before (get-balance tx-sender)))
    (if (is-eq balance-before u0)
      (ok false)
      (let (
          (to-withdraw (+ u1 (mod amount balance-before)))
          (fee (get-fee to-withdraw))
          (stx-before (stx-get-balance tx-sender))
        )
        (try! (withdraw to-withdraw))
        (asserts! (is-eq (get-balance tx-sender) (- balance-before to-withdraw))
          (err u204)
        )
        (asserts!
          (is-eq (stx-get-balance tx-sender) (+ stx-before (- to-withdraw fee)))
          (err u205)
        )
        (ok true)
      )
    )
  )
)
```

The test uses two techniques to stay useful:

1. It discards the input when the caller has no balance, because there is nothing to withdraw yet.
2. It scales the generated amount into the range from 1 to the caller's balance. Most generated amounts are larger than a balance, so discarding them would leave withdrawals mostly untested.

`test-set-fee` uses the same idea. For the admin, it scales the generated value into the allowed range, so most admin calls change the fee. For any other caller, it checks that `set-fee` fails with `ERR_NOT_ADMIN` and leaves the fee unchanged.

Run property-based testing with the same seed:

```bash
rv . vault test --seed=7
```

Output (trimmed):

```
Starting fresh round of property testing for the vault contract using user-provided configuration...

₿        5 Ӿ        7   wallet_6 [PASS] vault test-set-fee u17 (ok true)
₿      222 Ӿ      225   wallet_4 [PASS] vault test-set-fee u26 (ok true)
₿      820 Ӿ      824   wallet_8 [WARN] vault test-withdraw u16 (ok false)
₿      820 Ӿ      825   wallet_8 [WARN] vault test-withdraw u2057929303 (ok false)
₿      820 Ӿ      826   deployer [PASS] vault test-deposit u19 (ok true)
...

OK, properties passed after 100 runs.


EXECUTION STATISTICS

│ PROPERTY TEST CALLS
│
├─ + PASSED
│    ├─ test-deposit: x28
│    ├─ test-set-fee: x33
│    └─ test-withdraw: x31
│
├─ ! DISCARDED
│    ├─ test-deposit: x0
│    ├─ test-set-fee: x0
│    └─ test-withdraw: x8
│
└─ - FAILED
     ├─ test-deposit: x0
     ├─ test-set-fee: x0
     └─ test-withdraw: x0
```

All 100 runs either passed or were discarded. `test-withdraw` was discarded 8 times, each time for a caller that hadn't deposited yet. If a test is discarded in most runs, change how it chooses its inputs or increase `--runs`. Note that the `test-set-fee` lines show the generated value, not the fee that the test set after scaling it.

## Step 3: Introduce a Fee Bug

In `withdraw`, comment out the line that pays out the amount minus the fee, and uncomment the line below it:

```clarity
    ;; (try! (as-contract (stx-transfer? (- amount fee) tx-sender recipient)))
    (try! (as-contract (stx-transfer? amount tx-sender recipient)))
```

The vault now pays out the full amount, but it still records the fee as kept. Example-based tests can easily miss this bug. The fee starts at zero, so the bug has no effect until the admin sets a fee. Even then, the fee rounds down to zero for small amounts: with a fee of 25 basis points, withdrawals below 400 micro-STX have no fee. A unit test that deposits and withdraws 100 micro-STX passes with or without the bug.

### Catch the Bug with the Invariant

Run invariant testing again:

```bash
rv . vault invariant --seed=7
```

Output (trimmed):

```
₿     1325 Ӿ     1358   deployer        vault set-fee u30 (ok true)
₿     1325 Ӿ     1359   wallet_4        vault withdraw u13 (err u102)
₿     1325 Ӿ     1359   wallet_8 [PASS] vault invariant-holdings-match-ledger  true
₿     1325 Ӿ     1361   deployer        vault withdraw u188759751 (ok u188193472)
₿     1325 Ӿ     1362   wallet_7        vault set-fee u27 (err u100)
₿     1325 Ӿ     1363   wallet_4        vault set-fee u2101658649 (err u100)
₿     1325 Ӿ     1364   wallet_3        vault set-fee u1872614031 (err u100)
₿     1325 Ӿ     1366   wallet_3        vault withdraw u14 (ok u14)
₿     1325 Ӿ     1366   wallet_1 [FAIL] vault invariant-holdings-match-ledger  false
...
₿     1325 Ӿ     1388   wallet_3        vault deposit u0 (err u101)
₿     1325 Ӿ     1388   wallet_3 [FAIL] vault invariant-holdings-match-ledger  false

Error: Property failed after 5 tests.
Seed : 7

Counterexample:
- Contract : vault
- Functions: deposit (public)
- Arguments: u0
- Callers  : wallet_3
...
```

The admin set the fee to 30 basis points, and the invariant still held after that run. In the next run, the deployer withdrew 188759751 micro-STX. `withdraw` returned `(ok u188193472)`, the amount minus the fee, but the changed line sent the full amount. The vault now holds 566279 micro-STX less than its ledger records, and the invariant failed at the end of the run.

The counterexample, a rejected `deposit u0`, doesn't explain the failure. After a failure, Rendezvous shrinks the failing run to a smaller run that still fails. The vault's state carries over between runs, so once the ledger is broken, every later check fails, even after a call that changes nothing. To find the cause, look for the first `[FAIL]` line and the calls before it.

### Catch the Bug with a Property

Run property-based testing again:

```bash
rv . vault test --seed=7
```

Output (trimmed):

```
₿     3795 Ӿ     3812   deployer [PASS] vault test-set-fee u702349074 (ok true)
₿     3795 Ӿ     3813   wallet_5 [PASS] vault test-set-fee u2020939821 (ok true)
₿     3795 Ӿ     3814   wallet_5 [FAIL] vault test-withdraw u454921551 (err u205)
...
₿     3795 Ӿ     3846   wallet_5 [PASS] vault test-withdraw u22 (ok true)
₿     3795 Ӿ     3847   wallet_5 [FAIL] vault test-withdraw u23 (err u205)
₿     3795 Ӿ     3848   wallet_5 [PASS] vault test-withdraw u22 (ok true)
₿     3795 Ӿ     3849   wallet_5 [FAIL] vault test-withdraw u23 (err u205)

Error: Property failed after 18 tests.
Seed : 7

Counterexample:
- Contract : vault
- Test Function : test-withdraw (private)
- Arguments     : u23
- Caller        : wallet_5
...
```

The admin's `test-set-fee` call scaled the generated value `u702349074` to a fee of 427 basis points. `wallet_5` had deposited earlier, so its `test-withdraw` call ran and returned `(err u205)`: the caller received more than the amount minus the fee. Rendezvous then shrank the input to `u23`, which withdraws 24 micro-STX. That is the smallest withdrawal with a fee at 427 basis points: 24 × 427 / 10000 rounds down to 1, while 23 × 427 / 10000 rounds down to 0. Unlike the invariant's counterexample, this failure names the rule that broke: the amount that `withdraw` pays out.

## Step 4: Fix the Bug and Replay the Failures

Restore the original line in `withdraw`:

```clarity
    (try! (as-contract (stx-transfer? (- amount fee) tx-sender recipient)))
    ;; (try! (as-contract (stx-transfer? amount tx-sender recipient)))
```

When a run fails, Rendezvous saves its seed in the `.rendezvous-regressions` directory (see the `--regr` option in [Usage](chapter_6.md#options)). Replay the saved failures against the fixed contract:

```bash
rv . vault test --regr
rv . vault invariant --regr
```

Both commands replay the saved seed and pass. For example, the first one prints:

```
Found 1 regressions for the vault contract.

-------------------------------------------------------------------------------
...
OK, properties passed after 100 runs.
```

A replay doesn't always repeat the failing scenario. Editing the contract can change the order of the accounts, so the replay can assign different callers (see the note in Step 1). Also run new random sequences, for example:

```bash
rv . vault test --runs=1000
rv . vault invariant --runs=1000
```

The saved failures stay in `.rendezvous-regressions`. Delete that directory if you don't want to keep them.

## What You Learned

- An invariant checks a rule after any sequence of calls. It doesn't need to know which function breaks the rule, but its counterexample may not show the cause.
- A property-based test checks the effect of one function and names the rule that broke, but it only checks what it was written to check.
- Tests can depend on state that earlier calls created. Discard inputs that don't apply, and derive inputs from the current state, so that most runs still check something.
- Read the statistics: discarded tests and ignored calls check nothing.
- Passing runs show that the rules held for the sequences that Rendezvous generated. They don't prove that the contract is correct.

## Next Steps

- **More examples**: Study the other contracts in the example project (see [Chapter 8](chapter_8.md)).
- **Your own contracts**: Write down the rules that connect your contract's state, and check them with invariants and property-based tests.
