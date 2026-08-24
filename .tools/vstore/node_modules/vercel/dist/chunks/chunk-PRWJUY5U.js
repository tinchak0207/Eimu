import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  __commonJS
} from "./chunk-TZ2YI2VH.js";

// ../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/is_date/index.js
var require_is_date = __commonJS({
  "../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/is_date/index.js"(exports, module) {
    function isDate(argument) {
      return argument instanceof Date;
    }
    module.exports = isDate;
  }
});

// ../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/parse/index.js
var require_parse = __commonJS({
  "../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/parse/index.js"(exports, module) {
    var isDate = require_is_date();
    var MILLISECONDS_IN_HOUR = 36e5;
    var MILLISECONDS_IN_MINUTE = 6e4;
    var DEFAULT_ADDITIONAL_DIGITS = 2;
    var parseTokenDateTimeDelimeter = /[T ]/;
    var parseTokenPlainTime = /:/;
    var parseTokenYY = /^(\d{2})$/;
    var parseTokensYYY = [
      /^([+-]\d{2})$/,
      // 0 additional digits
      /^([+-]\d{3})$/,
      // 1 additional digit
      /^([+-]\d{4})$/
      // 2 additional digits
    ];
    var parseTokenYYYY = /^(\d{4})/;
    var parseTokensYYYYY = [
      /^([+-]\d{4})/,
      // 0 additional digits
      /^([+-]\d{5})/,
      // 1 additional digit
      /^([+-]\d{6})/
      // 2 additional digits
    ];
    var parseTokenMM = /^-(\d{2})$/;
    var parseTokenDDD = /^-?(\d{3})$/;
    var parseTokenMMDD = /^-?(\d{2})-?(\d{2})$/;
    var parseTokenWww = /^-?W(\d{2})$/;
    var parseTokenWwwD = /^-?W(\d{2})-?(\d{1})$/;
    var parseTokenHH = /^(\d{2}([.,]\d*)?)$/;
    var parseTokenHHMM = /^(\d{2}):?(\d{2}([.,]\d*)?)$/;
    var parseTokenHHMMSS = /^(\d{2}):?(\d{2}):?(\d{2}([.,]\d*)?)$/;
    var parseTokenTimezone = /([Z+-].*)$/;
    var parseTokenTimezoneZ = /^(Z)$/;
    var parseTokenTimezoneHH = /^([+-])(\d{2})$/;
    var parseTokenTimezoneHHMM = /^([+-])(\d{2}):?(\d{2})$/;
    function parse(argument, dirtyOptions) {
      if (isDate(argument)) {
        return new Date(argument.getTime());
      } else if (typeof argument !== "string") {
        return new Date(argument);
      }
      var options = dirtyOptions || {};
      var additionalDigits = options.additionalDigits;
      if (additionalDigits == null) {
        additionalDigits = DEFAULT_ADDITIONAL_DIGITS;
      } else {
        additionalDigits = Number(additionalDigits);
      }
      var dateStrings = splitDateString(argument);
      var parseYearResult = parseYear(dateStrings.date, additionalDigits);
      var year = parseYearResult.year;
      var restDateString = parseYearResult.restDateString;
      var date = parseDate(restDateString, year);
      if (date) {
        var timestamp = date.getTime();
        var time = 0;
        var offset;
        if (dateStrings.time) {
          time = parseTime(dateStrings.time);
        }
        if (dateStrings.timezone) {
          offset = parseTimezone(dateStrings.timezone);
        } else {
          offset = new Date(timestamp + time).getTimezoneOffset();
          offset = new Date(timestamp + time + offset * MILLISECONDS_IN_MINUTE).getTimezoneOffset();
        }
        return new Date(timestamp + time + offset * MILLISECONDS_IN_MINUTE);
      } else {
        return new Date(argument);
      }
    }
    function splitDateString(dateString) {
      var dateStrings = {};
      var array = dateString.split(parseTokenDateTimeDelimeter);
      var timeString;
      if (parseTokenPlainTime.test(array[0])) {
        dateStrings.date = null;
        timeString = array[0];
      } else {
        dateStrings.date = array[0];
        timeString = array[1];
      }
      if (timeString) {
        var token = parseTokenTimezone.exec(timeString);
        if (token) {
          dateStrings.time = timeString.replace(token[1], "");
          dateStrings.timezone = token[1];
        } else {
          dateStrings.time = timeString;
        }
      }
      return dateStrings;
    }
    function parseYear(dateString, additionalDigits) {
      var parseTokenYYY = parseTokensYYY[additionalDigits];
      var parseTokenYYYYY = parseTokensYYYYY[additionalDigits];
      var token;
      token = parseTokenYYYY.exec(dateString) || parseTokenYYYYY.exec(dateString);
      if (token) {
        var yearString = token[1];
        return {
          year: parseInt(yearString, 10),
          restDateString: dateString.slice(yearString.length)
        };
      }
      token = parseTokenYY.exec(dateString) || parseTokenYYY.exec(dateString);
      if (token) {
        var centuryString = token[1];
        return {
          year: parseInt(centuryString, 10) * 100,
          restDateString: dateString.slice(centuryString.length)
        };
      }
      return {
        year: null
      };
    }
    function parseDate(dateString, year) {
      if (year === null) {
        return null;
      }
      var token;
      var date;
      var month;
      var week;
      if (dateString.length === 0) {
        date = /* @__PURE__ */ new Date(0);
        date.setUTCFullYear(year);
        return date;
      }
      token = parseTokenMM.exec(dateString);
      if (token) {
        date = /* @__PURE__ */ new Date(0);
        month = parseInt(token[1], 10) - 1;
        date.setUTCFullYear(year, month);
        return date;
      }
      token = parseTokenDDD.exec(dateString);
      if (token) {
        date = /* @__PURE__ */ new Date(0);
        var dayOfYear = parseInt(token[1], 10);
        date.setUTCFullYear(year, 0, dayOfYear);
        return date;
      }
      token = parseTokenMMDD.exec(dateString);
      if (token) {
        date = /* @__PURE__ */ new Date(0);
        month = parseInt(token[1], 10) - 1;
        var day = parseInt(token[2], 10);
        date.setUTCFullYear(year, month, day);
        return date;
      }
      token = parseTokenWww.exec(dateString);
      if (token) {
        week = parseInt(token[1], 10) - 1;
        return dayOfISOYear(year, week);
      }
      token = parseTokenWwwD.exec(dateString);
      if (token) {
        week = parseInt(token[1], 10) - 1;
        var dayOfWeek = parseInt(token[2], 10) - 1;
        return dayOfISOYear(year, week, dayOfWeek);
      }
      return null;
    }
    function parseTime(timeString) {
      var token;
      var hours;
      var minutes;
      token = parseTokenHH.exec(timeString);
      if (token) {
        hours = parseFloat(token[1].replace(",", "."));
        return hours % 24 * MILLISECONDS_IN_HOUR;
      }
      token = parseTokenHHMM.exec(timeString);
      if (token) {
        hours = parseInt(token[1], 10);
        minutes = parseFloat(token[2].replace(",", "."));
        return hours % 24 * MILLISECONDS_IN_HOUR + minutes * MILLISECONDS_IN_MINUTE;
      }
      token = parseTokenHHMMSS.exec(timeString);
      if (token) {
        hours = parseInt(token[1], 10);
        minutes = parseInt(token[2], 10);
        var seconds = parseFloat(token[3].replace(",", "."));
        return hours % 24 * MILLISECONDS_IN_HOUR + minutes * MILLISECONDS_IN_MINUTE + seconds * 1e3;
      }
      return null;
    }
    function parseTimezone(timezoneString) {
      var token;
      var absoluteOffset;
      token = parseTokenTimezoneZ.exec(timezoneString);
      if (token) {
        return 0;
      }
      token = parseTokenTimezoneHH.exec(timezoneString);
      if (token) {
        absoluteOffset = parseInt(token[2], 10) * 60;
        return token[1] === "+" ? -absoluteOffset : absoluteOffset;
      }
      token = parseTokenTimezoneHHMM.exec(timezoneString);
      if (token) {
        absoluteOffset = parseInt(token[2], 10) * 60 + parseInt(token[3], 10);
        return token[1] === "+" ? -absoluteOffset : absoluteOffset;
      }
      return 0;
    }
    function dayOfISOYear(isoYear, week, day) {
      week = week || 0;
      day = day || 0;
      var date = /* @__PURE__ */ new Date(0);
      date.setUTCFullYear(isoYear, 0, 4);
      var fourthOfJanuaryDay = date.getUTCDay() || 7;
      var diff = week * 7 + day + 1 - fourthOfJanuaryDay;
      date.setUTCDate(date.getUTCDate() + diff);
      return date;
    }
    module.exports = parse;
  }
});

// ../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/start_of_year/index.js
var require_start_of_year = __commonJS({
  "../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/start_of_year/index.js"(exports, module) {
    var parse = require_parse();
    function startOfYear(dirtyDate) {
      var cleanDate = parse(dirtyDate);
      var date = /* @__PURE__ */ new Date(0);
      date.setFullYear(cleanDate.getFullYear(), 0, 1);
      date.setHours(0, 0, 0, 0);
      return date;
    }
    module.exports = startOfYear;
  }
});

// ../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/start_of_day/index.js
var require_start_of_day = __commonJS({
  "../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/start_of_day/index.js"(exports, module) {
    var parse = require_parse();
    function startOfDay(dirtyDate) {
      var date = parse(dirtyDate);
      date.setHours(0, 0, 0, 0);
      return date;
    }
    module.exports = startOfDay;
  }
});

// ../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/difference_in_calendar_days/index.js
var require_difference_in_calendar_days = __commonJS({
  "../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/difference_in_calendar_days/index.js"(exports, module) {
    var startOfDay = require_start_of_day();
    var MILLISECONDS_IN_MINUTE = 6e4;
    var MILLISECONDS_IN_DAY = 864e5;
    function differenceInCalendarDays(dirtyDateLeft, dirtyDateRight) {
      var startOfDayLeft = startOfDay(dirtyDateLeft);
      var startOfDayRight = startOfDay(dirtyDateRight);
      var timestampLeft = startOfDayLeft.getTime() - startOfDayLeft.getTimezoneOffset() * MILLISECONDS_IN_MINUTE;
      var timestampRight = startOfDayRight.getTime() - startOfDayRight.getTimezoneOffset() * MILLISECONDS_IN_MINUTE;
      return Math.round((timestampLeft - timestampRight) / MILLISECONDS_IN_DAY);
    }
    module.exports = differenceInCalendarDays;
  }
});

// ../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/get_day_of_year/index.js
var require_get_day_of_year = __commonJS({
  "../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/get_day_of_year/index.js"(exports, module) {
    var parse = require_parse();
    var startOfYear = require_start_of_year();
    var differenceInCalendarDays = require_difference_in_calendar_days();
    function getDayOfYear(dirtyDate) {
      var date = parse(dirtyDate);
      var diff = differenceInCalendarDays(date, startOfYear(date));
      var dayOfYear = diff + 1;
      return dayOfYear;
    }
    module.exports = getDayOfYear;
  }
});

// ../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/start_of_week/index.js
var require_start_of_week = __commonJS({
  "../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/start_of_week/index.js"(exports, module) {
    var parse = require_parse();
    function startOfWeek(dirtyDate, dirtyOptions) {
      var weekStartsOn = dirtyOptions ? Number(dirtyOptions.weekStartsOn) || 0 : 0;
      var date = parse(dirtyDate);
      var day = date.getDay();
      var diff = (day < weekStartsOn ? 7 : 0) + day - weekStartsOn;
      date.setDate(date.getDate() - diff);
      date.setHours(0, 0, 0, 0);
      return date;
    }
    module.exports = startOfWeek;
  }
});

// ../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/start_of_iso_week/index.js
var require_start_of_iso_week = __commonJS({
  "../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/start_of_iso_week/index.js"(exports, module) {
    var startOfWeek = require_start_of_week();
    function startOfISOWeek(dirtyDate) {
      return startOfWeek(dirtyDate, { weekStartsOn: 1 });
    }
    module.exports = startOfISOWeek;
  }
});

// ../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/get_iso_year/index.js
var require_get_iso_year = __commonJS({
  "../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/get_iso_year/index.js"(exports, module) {
    var parse = require_parse();
    var startOfISOWeek = require_start_of_iso_week();
    function getISOYear(dirtyDate) {
      var date = parse(dirtyDate);
      var year = date.getFullYear();
      var fourthOfJanuaryOfNextYear = /* @__PURE__ */ new Date(0);
      fourthOfJanuaryOfNextYear.setFullYear(year + 1, 0, 4);
      fourthOfJanuaryOfNextYear.setHours(0, 0, 0, 0);
      var startOfNextYear = startOfISOWeek(fourthOfJanuaryOfNextYear);
      var fourthOfJanuaryOfThisYear = /* @__PURE__ */ new Date(0);
      fourthOfJanuaryOfThisYear.setFullYear(year, 0, 4);
      fourthOfJanuaryOfThisYear.setHours(0, 0, 0, 0);
      var startOfThisYear = startOfISOWeek(fourthOfJanuaryOfThisYear);
      if (date.getTime() >= startOfNextYear.getTime()) {
        return year + 1;
      } else if (date.getTime() >= startOfThisYear.getTime()) {
        return year;
      } else {
        return year - 1;
      }
    }
    module.exports = getISOYear;
  }
});

// ../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/start_of_iso_year/index.js
var require_start_of_iso_year = __commonJS({
  "../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/start_of_iso_year/index.js"(exports, module) {
    var getISOYear = require_get_iso_year();
    var startOfISOWeek = require_start_of_iso_week();
    function startOfISOYear(dirtyDate) {
      var year = getISOYear(dirtyDate);
      var fourthOfJanuary = /* @__PURE__ */ new Date(0);
      fourthOfJanuary.setFullYear(year, 0, 4);
      fourthOfJanuary.setHours(0, 0, 0, 0);
      var date = startOfISOWeek(fourthOfJanuary);
      return date;
    }
    module.exports = startOfISOYear;
  }
});

// ../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/get_iso_week/index.js
var require_get_iso_week = __commonJS({
  "../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/get_iso_week/index.js"(exports, module) {
    var parse = require_parse();
    var startOfISOWeek = require_start_of_iso_week();
    var startOfISOYear = require_start_of_iso_year();
    var MILLISECONDS_IN_WEEK = 6048e5;
    function getISOWeek(dirtyDate) {
      var date = parse(dirtyDate);
      var diff = startOfISOWeek(date).getTime() - startOfISOYear(date).getTime();
      return Math.round(diff / MILLISECONDS_IN_WEEK) + 1;
    }
    module.exports = getISOWeek;
  }
});

// ../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/is_valid/index.js
var require_is_valid = __commonJS({
  "../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/is_valid/index.js"(exports, module) {
    var isDate = require_is_date();
    function isValid(dirtyDate) {
      if (isDate(dirtyDate)) {
        return !isNaN(dirtyDate);
      } else {
        throw new TypeError(toString.call(dirtyDate) + " is not an instance of Date");
      }
    }
    module.exports = isValid;
  }
});

// ../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/locale/en/build_distance_in_words_locale/index.js
var require_build_distance_in_words_locale = __commonJS({
  "../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/locale/en/build_distance_in_words_locale/index.js"(exports, module) {
    function buildDistanceInWordsLocale() {
      var distanceInWordsLocale = {
        lessThanXSeconds: {
          one: "less than a second",
          other: "less than {{count}} seconds"
        },
        xSeconds: {
          one: "1 second",
          other: "{{count}} seconds"
        },
        halfAMinute: "half a minute",
        lessThanXMinutes: {
          one: "less than a minute",
          other: "less than {{count}} minutes"
        },
        xMinutes: {
          one: "1 minute",
          other: "{{count}} minutes"
        },
        aboutXHours: {
          one: "about 1 hour",
          other: "about {{count}} hours"
        },
        xHours: {
          one: "1 hour",
          other: "{{count}} hours"
        },
        xDays: {
          one: "1 day",
          other: "{{count}} days"
        },
        aboutXMonths: {
          one: "about 1 month",
          other: "about {{count}} months"
        },
        xMonths: {
          one: "1 month",
          other: "{{count}} months"
        },
        aboutXYears: {
          one: "about 1 year",
          other: "about {{count}} years"
        },
        xYears: {
          one: "1 year",
          other: "{{count}} years"
        },
        overXYears: {
          one: "over 1 year",
          other: "over {{count}} years"
        },
        almostXYears: {
          one: "almost 1 year",
          other: "almost {{count}} years"
        }
      };
      function localize(token, count, options) {
        options = options || {};
        var result;
        if (typeof distanceInWordsLocale[token] === "string") {
          result = distanceInWordsLocale[token];
        } else if (count === 1) {
          result = distanceInWordsLocale[token].one;
        } else {
          result = distanceInWordsLocale[token].other.replace("{{count}}", count);
        }
        if (options.addSuffix) {
          if (options.comparison > 0) {
            return "in " + result;
          } else {
            return result + " ago";
          }
        }
        return result;
      }
      return {
        localize
      };
    }
    module.exports = buildDistanceInWordsLocale;
  }
});

// ../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/locale/_lib/build_formatting_tokens_reg_exp/index.js
var require_build_formatting_tokens_reg_exp = __commonJS({
  "../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/locale/_lib/build_formatting_tokens_reg_exp/index.js"(exports, module) {
    var commonFormatterKeys = [
      "M",
      "MM",
      "Q",
      "D",
      "DD",
      "DDD",
      "DDDD",
      "d",
      "E",
      "W",
      "WW",
      "YY",
      "YYYY",
      "GG",
      "GGGG",
      "H",
      "HH",
      "h",
      "hh",
      "m",
      "mm",
      "s",
      "ss",
      "S",
      "SS",
      "SSS",
      "Z",
      "ZZ",
      "X",
      "x"
    ];
    function buildFormattingTokensRegExp(formatters) {
      var formatterKeys = [];
      for (var key in formatters) {
        if (formatters.hasOwnProperty(key)) {
          formatterKeys.push(key);
        }
      }
      var formattingTokens = commonFormatterKeys.concat(formatterKeys).sort().reverse();
      var formattingTokensRegExp = new RegExp(
        "(\\[[^\\[]*\\])|(\\\\)?(" + formattingTokens.join("|") + "|.)",
        "g"
      );
      return formattingTokensRegExp;
    }
    module.exports = buildFormattingTokensRegExp;
  }
});

// ../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/locale/en/build_format_locale/index.js
var require_build_format_locale = __commonJS({
  "../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/locale/en/build_format_locale/index.js"(exports, module) {
    var buildFormattingTokensRegExp = require_build_formatting_tokens_reg_exp();
    function buildFormatLocale() {
      var months3char = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      var monthsFull = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      var weekdays2char = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
      var weekdays3char = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      var weekdaysFull = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      var meridiemUppercase = ["AM", "PM"];
      var meridiemLowercase = ["am", "pm"];
      var meridiemFull = ["a.m.", "p.m."];
      var formatters = {
        // Month: Jan, Feb, ..., Dec
        "MMM": function(date) {
          return months3char[date.getMonth()];
        },
        // Month: January, February, ..., December
        "MMMM": function(date) {
          return monthsFull[date.getMonth()];
        },
        // Day of week: Su, Mo, ..., Sa
        "dd": function(date) {
          return weekdays2char[date.getDay()];
        },
        // Day of week: Sun, Mon, ..., Sat
        "ddd": function(date) {
          return weekdays3char[date.getDay()];
        },
        // Day of week: Sunday, Monday, ..., Saturday
        "dddd": function(date) {
          return weekdaysFull[date.getDay()];
        },
        // AM, PM
        "A": function(date) {
          return date.getHours() / 12 >= 1 ? meridiemUppercase[1] : meridiemUppercase[0];
        },
        // am, pm
        "a": function(date) {
          return date.getHours() / 12 >= 1 ? meridiemLowercase[1] : meridiemLowercase[0];
        },
        // a.m., p.m.
        "aa": function(date) {
          return date.getHours() / 12 >= 1 ? meridiemFull[1] : meridiemFull[0];
        }
      };
      var ordinalFormatters = ["M", "D", "DDD", "d", "Q", "W"];
      ordinalFormatters.forEach(function(formatterToken) {
        formatters[formatterToken + "o"] = function(date, formatters2) {
          return ordinal(formatters2[formatterToken](date));
        };
      });
      return {
        formatters,
        formattingTokensRegExp: buildFormattingTokensRegExp(formatters)
      };
    }
    function ordinal(number) {
      var rem100 = number % 100;
      if (rem100 > 20 || rem100 < 10) {
        switch (rem100 % 10) {
          case 1:
            return number + "st";
          case 2:
            return number + "nd";
          case 3:
            return number + "rd";
        }
      }
      return number + "th";
    }
    module.exports = buildFormatLocale;
  }
});

// ../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/locale/en/index.js
var require_en = __commonJS({
  "../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/locale/en/index.js"(exports, module) {
    var buildDistanceInWordsLocale = require_build_distance_in_words_locale();
    var buildFormatLocale = require_build_format_locale();
    module.exports = {
      distanceInWords: buildDistanceInWordsLocale(),
      format: buildFormatLocale()
    };
  }
});

// ../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/format/index.js
var require_format = __commonJS({
  "../../node_modules/.pnpm/date-fns@1.29.0/node_modules/date-fns/format/index.js"(exports, module) {
    var getDayOfYear = require_get_day_of_year();
    var getISOWeek = require_get_iso_week();
    var getISOYear = require_get_iso_year();
    var parse = require_parse();
    var isValid = require_is_valid();
    var enLocale = require_en();
    function format(dirtyDate, dirtyFormatStr, dirtyOptions) {
      var formatStr = dirtyFormatStr ? String(dirtyFormatStr) : "YYYY-MM-DDTHH:mm:ss.SSSZ";
      var options = dirtyOptions || {};
      var locale = options.locale;
      var localeFormatters = enLocale.format.formatters;
      var formattingTokensRegExp = enLocale.format.formattingTokensRegExp;
      if (locale && locale.format && locale.format.formatters) {
        localeFormatters = locale.format.formatters;
        if (locale.format.formattingTokensRegExp) {
          formattingTokensRegExp = locale.format.formattingTokensRegExp;
        }
      }
      var date = parse(dirtyDate);
      if (!isValid(date)) {
        return "Invalid Date";
      }
      var formatFn = buildFormatFn(formatStr, localeFormatters, formattingTokensRegExp);
      return formatFn(date);
    }
    var formatters = {
      // Month: 1, 2, ..., 12
      "M": function(date) {
        return date.getMonth() + 1;
      },
      // Month: 01, 02, ..., 12
      "MM": function(date) {
        return addLeadingZeros(date.getMonth() + 1, 2);
      },
      // Quarter: 1, 2, 3, 4
      "Q": function(date) {
        return Math.ceil((date.getMonth() + 1) / 3);
      },
      // Day of month: 1, 2, ..., 31
      "D": function(date) {
        return date.getDate();
      },
      // Day of month: 01, 02, ..., 31
      "DD": function(date) {
        return addLeadingZeros(date.getDate(), 2);
      },
      // Day of year: 1, 2, ..., 366
      "DDD": function(date) {
        return getDayOfYear(date);
      },
      // Day of year: 001, 002, ..., 366
      "DDDD": function(date) {
        return addLeadingZeros(getDayOfYear(date), 3);
      },
      // Day of week: 0, 1, ..., 6
      "d": function(date) {
        return date.getDay();
      },
      // Day of ISO week: 1, 2, ..., 7
      "E": function(date) {
        return date.getDay() || 7;
      },
      // ISO week: 1, 2, ..., 53
      "W": function(date) {
        return getISOWeek(date);
      },
      // ISO week: 01, 02, ..., 53
      "WW": function(date) {
        return addLeadingZeros(getISOWeek(date), 2);
      },
      // Year: 00, 01, ..., 99
      "YY": function(date) {
        return addLeadingZeros(date.getFullYear(), 4).substr(2);
      },
      // Year: 1900, 1901, ..., 2099
      "YYYY": function(date) {
        return addLeadingZeros(date.getFullYear(), 4);
      },
      // ISO week-numbering year: 00, 01, ..., 99
      "GG": function(date) {
        return String(getISOYear(date)).substr(2);
      },
      // ISO week-numbering year: 1900, 1901, ..., 2099
      "GGGG": function(date) {
        return getISOYear(date);
      },
      // Hour: 0, 1, ... 23
      "H": function(date) {
        return date.getHours();
      },
      // Hour: 00, 01, ..., 23
      "HH": function(date) {
        return addLeadingZeros(date.getHours(), 2);
      },
      // Hour: 1, 2, ..., 12
      "h": function(date) {
        var hours = date.getHours();
        if (hours === 0) {
          return 12;
        } else if (hours > 12) {
          return hours % 12;
        } else {
          return hours;
        }
      },
      // Hour: 01, 02, ..., 12
      "hh": function(date) {
        return addLeadingZeros(formatters["h"](date), 2);
      },
      // Minute: 0, 1, ..., 59
      "m": function(date) {
        return date.getMinutes();
      },
      // Minute: 00, 01, ..., 59
      "mm": function(date) {
        return addLeadingZeros(date.getMinutes(), 2);
      },
      // Second: 0, 1, ..., 59
      "s": function(date) {
        return date.getSeconds();
      },
      // Second: 00, 01, ..., 59
      "ss": function(date) {
        return addLeadingZeros(date.getSeconds(), 2);
      },
      // 1/10 of second: 0, 1, ..., 9
      "S": function(date) {
        return Math.floor(date.getMilliseconds() / 100);
      },
      // 1/100 of second: 00, 01, ..., 99
      "SS": function(date) {
        return addLeadingZeros(Math.floor(date.getMilliseconds() / 10), 2);
      },
      // Millisecond: 000, 001, ..., 999
      "SSS": function(date) {
        return addLeadingZeros(date.getMilliseconds(), 3);
      },
      // Timezone: -01:00, +00:00, ... +12:00
      "Z": function(date) {
        return formatTimezone(date.getTimezoneOffset(), ":");
      },
      // Timezone: -0100, +0000, ... +1200
      "ZZ": function(date) {
        return formatTimezone(date.getTimezoneOffset());
      },
      // Seconds timestamp: 512969520
      "X": function(date) {
        return Math.floor(date.getTime() / 1e3);
      },
      // Milliseconds timestamp: 512969520900
      "x": function(date) {
        return date.getTime();
      }
    };
    function buildFormatFn(formatStr, localeFormatters, formattingTokensRegExp) {
      var array = formatStr.match(formattingTokensRegExp);
      var length = array.length;
      var i;
      var formatter;
      for (i = 0; i < length; i++) {
        formatter = localeFormatters[array[i]] || formatters[array[i]];
        if (formatter) {
          array[i] = formatter;
        } else {
          array[i] = removeFormattingTokens(array[i]);
        }
      }
      return function(date) {
        var output = "";
        for (var i2 = 0; i2 < length; i2++) {
          if (array[i2] instanceof Function) {
            output += array[i2](date, formatters);
          } else {
            output += array[i2];
          }
        }
        return output;
      };
    }
    function removeFormattingTokens(input) {
      if (input.match(/\[[\s\S]/)) {
        return input.replace(/^\[|]$/g, "");
      }
      return input.replace(/\\/g, "");
    }
    function formatTimezone(offset, delimeter) {
      delimeter = delimeter || "";
      var sign = offset > 0 ? "-" : "+";
      var absOffset = Math.abs(offset);
      var hours = Math.floor(absOffset / 60);
      var minutes = absOffset % 60;
      return sign + addLeadingZeros(hours, 2) + delimeter + addLeadingZeros(minutes, 2);
    }
    function addLeadingZeros(number, targetLength) {
      var output = Math.abs(number).toString();
      while (output.length < targetLength) {
        output = "0" + output;
      }
      return output;
    }
    module.exports = format;
  }
});

export {
  require_format
};
