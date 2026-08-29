from twilio_verify_conversion_audit import conversion_rate, prefix_of, verdict


def test_country_far_below_baseline_on_volume_is_a_collapse():
    row = {"country": "ID", "total_attempts": 812, "total_converted": 25,
           "conversion_rate_percentage": 3.1}
    state, detail = verdict(row, 64.0)
    assert state == "collapse"
    assert "pumping" in detail


def test_same_rate_on_nine_attempts_is_too_thin_to_read():
    # The volume floor is what keeps the report free of countries where four
    # people signed up this week.
    row = {"country": "MT", "total_attempts": 9, "total_converted": 0,
           "conversion_rate_percentage": 0.0}
    state, detail = verdict(row, 64.0)
    assert state == "thin"
    assert "floor" in detail


def test_judgement_is_relative_so_a_low_baseline_service_still_works():
    # 9% would trip any fixed threshold, and on this service it is normal.
    row = {"country": "BR", "total_attempts": 400, "total_converted": 36,
           "conversion_rate_percentage": 9.0}
    assert verdict(row, 11.0)[0] == "healthy"
    # Same service, a country at a fifth of that baseline.
    hit = {"country": "PK", "total_attempts": 400, "total_converted": 8,
           "conversion_rate_percentage": 2.0}
    assert verdict(hit, 11.0)[0] == "collapse"


def test_middling_country_is_watch_not_collapse():
    row = {"country": "PL", "total_attempts": 300, "total_converted": 120,
           "conversion_rate_percentage": 40.0}
    assert verdict(row, 64.0)[0] == "watch"


def test_rate_is_derived_from_the_counts_when_the_percentage_is_absent():
    assert conversion_rate({"total_attempts": 200, "total_converted": 50}) == 25.0
    assert conversion_rate({"total_attempts": 0, "total_converted": 0}) is None


def test_missing_baseline_refuses_to_judge():
    row = {"country": "US", "total_attempts": 500, "conversion_rate_percentage": 2.0}
    state, detail = verdict(row, None)
    assert state == "no-baseline"
    assert "widen the window" in detail


def test_prefix_keeps_the_leading_digits_only():
    assert prefix_of("+62 812-3456-7890") == "+628123"
    assert prefix_of(None) == "?"
