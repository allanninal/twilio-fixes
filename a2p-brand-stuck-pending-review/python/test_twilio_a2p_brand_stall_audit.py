from datetime import datetime, timezone

from twilio_a2p_brand_stall_audit import (age_days, duplicate_bundles,
                                          parsed_time, verdict)

NOW = datetime(2026, 3, 10, tzinfo=timezone.utc)


def brand(**kw):
    base = {"sid": "BN0123456789", "status": "PENDING",
            "date_created": "2026-03-09T12:00:00Z", "tcr_id": None}
    base.update(kw)
    return base


def test_pending_inside_the_window_is_not_a_finding():
    state, _ = verdict(brand(), NOW)
    assert state == "pending"


def test_the_same_brand_is_a_finding_nine_days_later():
    # Nothing about the object changes. Only the clock does, which is why the
    # classifier takes now as an argument instead of reading it.
    state, detail = verdict(brand(date_created="2026-03-01T00:00:00Z"), NOW)
    assert state == "pending-stalled"
    assert "9.0 day(s)" in detail


def test_in_review_past_the_threshold_is_reported_but_kept_separate():
    state, detail = verdict(
        brand(status="IN_REVIEW", date_created="2026-02-01T00:00:00Z"), NOW)
    assert state == "in-review-long"
    assert "nothing to submit" in detail


def test_an_unparseable_date_is_not_treated_as_zero_days_old():
    assert age_days(brand(date_created="last tuesday"), NOW) is None
    assert verdict(brand(date_created=""), NOW)[0] == "undated"


def test_a_naive_timestamp_is_read_as_utc():
    when = parsed_time("2026-03-09T12:00:00")
    assert when == datetime(2026, 3, 9, 12, tzinfo=timezone.utc)


def test_waiting_with_a_tcr_id_is_a_disagreement_not_a_wait():
    state, detail = verdict(brand(tcr_id="BXXXXXXX"), NOW)
    assert state == "waiting-with-tcr-id"
    assert "picking a side" in detail


def test_a_settled_brand_belongs_to_a_different_report():
    assert verdict(brand(status="FAILED"), NOW)[0] == "settled"
    assert verdict(brand(status="APPROVED"), NOW)[0] == "settled"


def test_two_brands_on_one_customer_profile_are_reported():
    brands = [brand(sid="BN1", customer_profile_bundle_sid="BU1"),
              brand(sid="BN2", customer_profile_bundle_sid="BU1"),
              brand(sid="BN3", customer_profile_bundle_sid="BU2")]
    assert duplicate_bundles(brands) == ["BU1"]


def test_brands_with_no_bundle_are_not_counted_as_duplicates_of_each_other():
    assert duplicate_bundles([brand(sid="BN1"), brand(sid="BN2")]) == []
