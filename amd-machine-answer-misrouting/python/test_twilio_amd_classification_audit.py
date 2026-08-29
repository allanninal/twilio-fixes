from twilio_amd_classification_audit import bucket, verdict


def test_short_machine_start_is_the_misroute_bucket():
    assert bucket({"status": "completed", "answered_by": "machine_start",
                   "duration": "4"}) == "machine-short"


def test_machine_end_beep_is_not_split_by_duration():
    # DetectMessageEnd waited for the greeting, so a short call means something
    # else and must not land in the misroute bucket.
    assert bucket({"status": "completed", "answered_by": "machine_end_beep",
                   "duration": "4"}) == "machine"


def test_calls_without_detection_stay_out_of_the_denominator():
    assert bucket({"status": "completed", "duration": "90"}) == "no-amd"
    assert bucket({"status": "no-answer", "answered_by": "unknown"}) == "not-completed"


def test_unknown_share_over_the_threshold_reads_as_a_timeout():
    state, detail = verdict({"human": 400, "machine": 80, "unknown": 30})
    assert state == "detection-timing-out"
    assert "timeout, not a category" in detail


def test_machine_heavy_with_a_short_tail_is_over_classifying():
    state, detail = verdict({"human": 100, "machine": 60, "machine-short": 40})
    assert state == "over-classifying"
    assert "hanging up" in detail


def test_machine_heavy_without_a_short_tail_is_a_list_not_a_detector():
    state, _ = verdict({"human": 100, "machine": 98, "machine-short": 2})
    assert state == "machine-heavy"


def test_thin_sample_is_reported_rather_than_scored():
    assert verdict({"human": 10, "machine": 4})[0] == "thin-sample"


def test_no_graded_calls_means_detection_was_never_asked_for():
    assert verdict({"no-amd": 900, "not-completed": 100})[0] == "no-amd"
