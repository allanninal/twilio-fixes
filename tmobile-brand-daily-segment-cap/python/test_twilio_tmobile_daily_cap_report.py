from twilio_tmobile_daily_cap_report import brand_ceiling, summarise, verdict

SOLE_PROP = {"brand_type": "SOLE_PROPRIETOR", "brand_score": None}
RUSSELL = {"brand_type": "STANDARD", "russell_3000": True}
STANDARD = {"brand_type": "STANDARD", "brand_score": 62, "russell_3000": False}


def test_segments_are_summed_not_messages_counted():
    # Four messages, ten segments. Counting rows would report 40% of a 25 cap.
    messages = [{"num_segments": "4"}, {"num_segments": "1"},
                {"num_segments": "3"}, {"num_segments": "2"}]
    assert summarise(messages) == (10, 0)


def test_unreadable_segment_counts_do_not_abort_the_sum():
    assert summarise([{"num_segments": "2"}, {"num_segments": None},
                      {"num_segments": "x"}]) == (2, 0)


def test_30023_is_counted_client_side():
    messages = [{"num_segments": "1", "error_code": 30023},
                {"num_segments": "1", "error_code": "30023"},
                {"num_segments": "1", "error_code": 30007}]
    assert summarise(messages) == (3, 2)


def test_an_observed_cap_hit_outranks_the_estimate():
    # The segment total is an upper bound across all carriers. A 30023 is not.
    state, detail = verdict(200000, 12, capped=3)
    assert state == "cap-hit"
    assert "midnight US Pacific" in detail


def test_sole_proprietor_ceiling_is_derived_from_the_brand():
    ceiling, source = brand_ceiling(SOLE_PROP)
    assert ceiling == 1000
    assert "1,000 segments" in source


def test_russell_3000_defaults_to_two_hundred_thousand():
    assert brand_ceiling(RUSSELL)[0] == 200000


def test_an_ordinary_standard_brand_has_no_readable_ceiling():
    ceiling, source = brand_ceiling(STANDARD)
    assert ceiling is None
    assert "--ceiling" in source


def test_the_warning_band_sits_below_the_line():
    assert verdict(1000, 850, 0)[0] == "near-cap"
    assert verdict(1000, 400, 0)[0] == "under-cap"
    assert verdict(1000, 1200, 0)[0] == "over-estimate"
    assert verdict(None, 400, 0)[0] == "ceiling-unknown"
