module proven::proven;

use sui::bcs;
use sui::clock::{Self, Clock};
use std::hash;
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::{Self, TxContext};
use std::vector;

const ETime: u64 = 0;
const EAuthority: u64 = 1;
const EShape: u64 = 2;
const ECommit: u64 = 3;
const EResolved: u64 = 4;
const EProbability: u64 = 5;

public struct Exam has key {
    id: UID,
    admin: address,
    question_digest: vector<u8>,
    baseline_bps: vector<u16>,
    cutoff_ms: u64,
    reveal_until_ms: u64,
    resolve_after_ms: u64,
}

public struct Commitment has key {
    id: UID,
    exam: ID,
    agent_id: vector<u8>,
    model_hash: vector<u8>,
    hash: vector<u8>,
    committed_ms: u64,
    resolved: bool,
}

public struct ExperienceReceipt has key {
    id: UID,
    exam: ID,
    commitment: ID,
    agent_id: vector<u8>,
    model_hash: vector<u8>,
    question_digest: vector<u8>,
    resolution_digest: vector<u8>,
    score_sum: u64,
    baseline_sum: u64,
    count: u64,
    committed_ms: u64,
    resolved_ms: u64,
}

public fun create_exam(
    question_digest: vector<u8>, baseline_bps: vector<u16>, cutoff_ms: u64,
    reveal_until_ms: u64, resolve_after_ms: u64, clock: &Clock, ctx: &mut TxContext,
) {
    assert!(vector::length(&question_digest) == 32, EShape);
    assert!(vector::length(&baseline_bps) >= 2 && vector::length(&baseline_bps) <= 30, EShape);
    assert!(clock::timestamp_ms(clock) < cutoff_ms && cutoff_ms < reveal_until_ms && reveal_until_ms < resolve_after_ms, ETime);
    let mut i = 0;
    while (i < vector::length(&baseline_bps)) {
        assert!(*vector::borrow(&baseline_bps, i) <= 10000, EProbability);
        i = i + 1;
    };
    transfer::share_object(Exam { id: object::new(ctx), admin: tx_context::sender(ctx), question_digest, baseline_bps, cutoff_ms, reveal_until_ms, resolve_after_ms });
}

public fun commit(
    exam: &Exam, digest: vector<u8>, agent_id: vector<u8>, model_hash: vector<u8>,
    clock: &Clock, ctx: &mut TxContext,
) {
    assert!(tx_context::sender(ctx) == exam.admin, EAuthority);
    assert!(clock::timestamp_ms(clock) < exam.cutoff_ms, ETime);
    assert!(vector::length(&digest) == 32 && vector::length(&model_hash) == 32, EShape);
    let created = Commitment {
        id: object::new(ctx), exam: object::id(exam), agent_id, model_hash,
        hash: digest, committed_ms: clock::timestamp_ms(clock), resolved: false,
    };
    transfer::transfer(created, tx_context::sender(ctx));
}

/// Operator resolves against the source specified in the published exam.
/// The chain checks the locked probabilities and exact Brier arithmetic;
/// it cannot independently establish that the operator chose the true outcome.
public fun record_result(
    exam: &Exam, commitment: &mut Commitment, probabilities: vector<u16>,
    salt: vector<u8>, outcomes: vector<bool>, resolution_digest: vector<u8>,
    clock: &Clock, ctx: &mut TxContext,
) {
    assert!(tx_context::sender(ctx) == exam.admin, EAuthority);
    assert!(clock::timestamp_ms(clock) >= exam.resolve_after_ms, ETime);
    assert!(commitment.exam == object::id(exam) && !commitment.resolved, EResolved);
    let n = vector::length(&exam.baseline_bps);
    assert!(n == vector::length(&probabilities) && n == vector::length(&outcomes), EShape);
    assert!(vector::length(&salt) == 32 && vector::length(&resolution_digest) == 32, EShape);
    let mut preimage = bcs::to_bytes(&probabilities);
    vector::append(&mut preimage, salt);
    assert!(hash::sha2_256(preimage) == commitment.hash, ECommit);
    let mut score_sum = 0u64;
    let mut baseline_sum = 0u64;
    let mut i = 0;
    while (i < n) {
        let p = (*vector::borrow(&probabilities, i)) as u64;
        let base = (*vector::borrow(&exam.baseline_bps, i)) as u64;
        assert!(p <= 10000, EProbability);
        let outcome = if (*vector::borrow(&outcomes, i)) { 10000u64 } else { 0u64 };
        let delta = if (p > outcome) { p - outcome } else { outcome - p };
        let base_delta = if (base > outcome) { base - outcome } else { outcome - base };
        score_sum = score_sum + delta * delta;
        baseline_sum = baseline_sum + base_delta * base_delta;
        i = i + 1;
    };
    commitment.resolved = true;
    transfer::freeze_object(ExperienceReceipt {
        id: object::new(ctx), exam: object::id(exam), commitment: object::id(commitment),
        agent_id: copy commitment.agent_id, model_hash: copy commitment.model_hash,
        question_digest: copy exam.question_digest, resolution_digest,
        score_sum, baseline_sum, count: n, committed_ms: commitment.committed_ms,
        resolved_ms: clock::timestamp_ms(clock),
    });
}

/// Read-only helpers for other Sui packages that receive a receipt as an
/// explicit transaction input. Apps must still set their own risk policy.
public fun score_sum(receipt: &ExperienceReceipt): u64 { receipt.score_sum }
public fun baseline_sum(receipt: &ExperienceReceipt): u64 { receipt.baseline_sum }
public fun question_count(receipt: &ExperienceReceipt): u64 { receipt.count }
public fun agent_id(receipt: &ExperienceReceipt): &vector<u8> { &receipt.agent_id }
public fun exam_id(receipt: &ExperienceReceipt): ID { receipt.exam }
