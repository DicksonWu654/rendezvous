;; A small STX vault used in the Stateful Testing Tutorial of the Rendezvous
;; book. Users deposit and withdraw STX. The admin (the deployer) can set a
;; withdrawal fee, which stays in the vault. Collecting fees is out of scope
;; for this example.

(define-constant VAULT (as-contract tx-sender))
(define-constant ADMIN tx-sender)
;; Fees are in basis points: u100 is 1%.
(define-constant MAX_FEE_BPS u1000)

(define-constant ERR_NOT_ADMIN (err u100))
(define-constant ERR_ZERO_AMOUNT (err u101))
(define-constant ERR_INSUFFICIENT_BALANCE (err u102))
(define-constant ERR_FEE_TOO_HIGH (err u103))

(define-data-var fee-bps uint u0)
(define-data-var total-balances uint u0)
(define-data-var total-fees uint u0)

(define-map balances
  principal
  uint
)

(define-read-only (get-balance (user principal))
  (default-to u0 (map-get? balances user))
)

(define-read-only (get-fee (amount uint))
  (/ (* amount (var-get fee-bps)) u10000)
)

(define-public (deposit (amount uint))
  (begin
    (asserts! (> amount u0) ERR_ZERO_AMOUNT)
    (try! (stx-transfer? amount tx-sender VAULT))
    (map-set balances tx-sender (+ (get-balance tx-sender) amount))
    (var-set total-balances (+ (var-get total-balances) amount))
    (ok true)
  )
)

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

(define-public (set-fee (new-fee-bps uint))
  (begin
    (asserts! (is-eq tx-sender ADMIN) ERR_NOT_ADMIN)
    (asserts! (<= new-fee-bps MAX_FEE_BPS) ERR_FEE_TOO_HIGH)
    (ok (var-set fee-bps new-fee-bps))
  )
)

;; #[env(simnet)]
(define-map context
  (string-ascii 100)
  { called: uint }
)

;; #[env(simnet)]
(define-private (update-context
    (function-name (string-ascii 100))
    (called uint)
  )
  (ok (map-set context function-name { called: called }))
)

;; #[env(simnet)]
;; The STX held by the vault must match what it owes its users plus the fees
;; it has kept.
(define-read-only (invariant-holdings-match-ledger)
  (is-eq (stx-get-balance VAULT)
    (+ (var-get total-balances) (var-get total-fees))
  )
)

;; #[env(simnet)]
;; A deposit adds the amount to the caller's balance. Discard amounts the
;; caller cannot deposit.
(define-private (test-deposit (amount uint))
  (if (or (is-eq amount u0) (> amount (stx-get-balance tx-sender)))
    (ok false)
    (let ((balance-before (get-balance tx-sender)))
      (try! (deposit amount))
      (asserts! (is-eq (get-balance tx-sender) (+ balance-before amount))
        (err u200)
      )
      (ok true)
    )
  )
)

;; #[env(simnet)]
;; Only the admin can change the fee. For the admin, scale the generated value
;; into the allowed range, so that most calls change the fee.
(define-private (test-set-fee (new-fee-bps uint))
  (if (is-eq tx-sender ADMIN)
    (let ((fee-bps-to-set (mod new-fee-bps (+ MAX_FEE_BPS u1))))
      (try! (set-fee fee-bps-to-set))
      (asserts! (is-eq (var-get fee-bps) fee-bps-to-set) (err u201))
      (ok true)
    )
    (let ((fee-bps-before (var-get fee-bps)))
      (asserts! (is-eq (set-fee new-fee-bps) ERR_NOT_ADMIN) (err u202))
      (asserts! (is-eq (var-get fee-bps) fee-bps-before) (err u203))
      (ok true)
    )
  )
)

;; #[env(simnet)]
;; A withdrawal reduces the caller's balance by the amount and pays out the
;; amount minus the fee. It needs an earlier deposit by the same caller, so
;; it discards callers with no balance and scales the generated amount to the
;; caller's balance.
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
