/**
 * Classes for an rsuite SelectPicker given a width. Its toggle sizes itself to its label
 * and ignores the width it is given: a long choice (a long class, or Tamil's "all
 * severities") ran over the next control (testing sheet TC_187), and a short one left a
 * gap after it, so a row of filters looked scattered. Held to the picker's width, the
 * row lines up from the left and a long label ends in an ellipsis.
 */
export const FILTER_PICKER = '[&_.rs-picker-toggle]:w-full [&_.rs-picker-toggle-value]:truncate';
