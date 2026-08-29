from twilio_verify_rate_limit_audit import starts_per_minute, verdict


def test_no_rate_limits_at_all_is_the_headline_finding():
    state, detail = verdict([])
    assert state == "unlimited"
    assert "per destination number guard" in detail


def test_limit_with_no_buckets_enforces_nothing():
    state, detail = verdict([{"unique_name": "end_user_ip", "buckets": []}])
    assert state == "inert"
    assert "end_user_ip" in detail


def test_five_per_minute_is_a_real_brake():
    state, detail = verdict([{"unique_name": "end_user_ip",
                              "buckets": [{"max": 5, "interval": 60}]}])
    assert state == "limited"
    assert "5.0/min" in detail


def test_a_thousand_a_minute_is_a_resource_not_a_brake():
    state, detail = verdict([{"unique_name": "end_user_ip",
                              "buckets": [{"max": 1000, "interval": 60}]}])
    assert state == "loose"
    assert "all day" in detail


def test_tightest_bucket_across_limits_is_the_one_that_binds():
    state, detail = verdict([
        {"unique_name": "user_id", "buckets": [{"max": 600, "interval": 60}]},
        {"unique_name": "end_user_ip", "buckets": [{"max": 5, "interval": 60}]},
    ])
    assert state == "limited"
    assert "end_user_ip" in detail


def test_an_abandoned_key_is_named_even_when_another_limit_works():
    state, detail = verdict([
        {"unique_name": "end_user_ip", "buckets": [{"max": 5, "interval": 60}]},
        {"unique_name": "prefix", "buckets": []},
    ])
    assert state == "limited"
    assert "no buckets on prefix" in detail


def test_buckets_are_normalised_to_starts_per_minute():
    assert starts_per_minute({"max": 25, "interval": 3600}) == 25 * 60 / 3600
    assert starts_per_minute({"max": 5, "interval": 0}) is None
    assert starts_per_minute({"max": None, "interval": 60}) is None
