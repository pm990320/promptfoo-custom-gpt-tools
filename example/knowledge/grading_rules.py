"""
Grading rules for student gradebook processing.
Used as a Code Interpreter knowledge file.
"""

import csv
import statistics
from collections import Counter
from typing import Optional


# Standard letter grade scale
GRADE_SCALE = [
    (93, "A"),
    (90, "A-"),
    (87, "B+"),
    (83, "B"),
    (80, "B-"),
    (77, "C+"),
    (73, "C"),
    (70, "C-"),
    (67, "D+"),
    (63, "D"),
    (60, "D-"),
    (0, "F"),
]


def score_to_letter(score: float) -> str:
    """Convert a numeric score (0-100) to a letter grade."""
    for threshold, letter in GRADE_SCALE:
        if score >= threshold:
            return letter
    return "F"


def parse_gradebook(csv_path: str) -> dict:
    """
    Parse a gradebook CSV file.

    Expected format:
    - First row: headers (Student, Assignment1, Assignment2, ...)
    - Optional second row starting with "Weight": per-assignment weights
    - Remaining rows: student data

    Returns dict with keys:
    - headers: list of column names
    - weights: dict of {assignment: weight} or None
    - students: list of dicts with student data
    """
    with open(csv_path, "r", newline="") as f:
        reader = csv.reader(f)
        headers = next(reader)
        headers = [h.strip() for h in headers]

        # Check if second row is weights
        second_row = next(reader)
        weights = None
        students = []

        if second_row[0].strip().lower() == "weight":
            weights = {}
            for i, h in enumerate(headers[1:], start=1):
                try:
                    weights[h] = float(second_row[i])
                except (ValueError, IndexError):
                    weights[h] = 1.0
        else:
            # Not a weight row, treat as student data
            students.append(_parse_student_row(headers, second_row))

        for row in reader:
            if not any(cell.strip() for cell in row):
                continue  # skip empty rows
            students.append(_parse_student_row(headers, row))

    return {
        "headers": headers,
        "weights": weights,
        "students": students,
    }


def _parse_student_row(headers: list, row: list) -> dict:
    """Parse a single student row into a dict."""
    student = {"name": row[0].strip()}
    scores = {}
    for i, h in enumerate(headers[1:], start=1):
        try:
            scores[h] = float(row[i]) if i < len(row) and row[i].strip() else None
        except ValueError:
            scores[h] = None
    student["scores"] = scores
    return student


def calculate_average(
    scores: dict, weights: Optional[dict] = None
) -> Optional[float]:
    """
    Calculate weighted or simple average.
    Returns None if more than 50% of scores are missing.
    """
    valid = {k: v for k, v in scores.items() if v is not None}

    if len(valid) < len(scores) * 0.5:
        return None  # Too many missing scores

    if weights:
        total_weight = sum(weights.get(k, 1.0) for k in valid)
        if total_weight == 0:
            return None
        weighted_sum = sum(v * weights.get(k, 1.0) for k, v in valid.items())
        return round(weighted_sum / total_weight, 2)
    else:
        return round(statistics.mean(valid.values()), 2)


def process_gradebook(csv_path: str) -> dict:
    """
    Process a gradebook CSV and return complete results.

    Returns dict with:
    - students: list of processed student records
    - statistics: class-level statistics
    - assignments: list of assignment names
    """
    data = parse_gradebook(csv_path)
    assignments = data["headers"][1:]

    processed_students = []
    averages = []

    for student in data["students"]:
        avg = calculate_average(student["scores"], data["weights"])
        record = {
            "name": student["name"],
            "scores": student["scores"],
            "average": avg,
            "letter_grade": score_to_letter(avg) if avg is not None else "Incomplete",
        }
        processed_students.append(record)
        if avg is not None:
            averages.append(avg)

    # Sort by average descending (Incomplete at bottom)
    processed_students.sort(
        key=lambda s: (s["average"] is not None, s["average"] or 0), reverse=True
    )

    # Class statistics
    grade_dist = Counter(s["letter_grade"] for s in processed_students)

    # Per-assignment averages
    assignment_avgs = {}
    for asgn in assignments:
        values = [
            s["scores"][asgn]
            for s in data["students"]
            if s["scores"].get(asgn) is not None
        ]
        assignment_avgs[asgn] = round(statistics.mean(values), 2) if values else None

    stats = {
        "class_average": round(statistics.mean(averages), 2) if averages else None,
        "median": round(statistics.median(averages), 2) if averages else None,
        "highest": max(averages) if averages else None,
        "lowest": min(averages) if averages else None,
        "grade_distribution": dict(grade_dist),
        "assignment_averages": assignment_avgs,
        "total_students": len(processed_students),
        "has_weights": data["weights"] is not None,
    }

    return {
        "students": processed_students,
        "statistics": stats,
        "assignments": assignments,
    }
