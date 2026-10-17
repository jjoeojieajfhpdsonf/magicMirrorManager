// My config – comments must survive every edit
let config = {
  address: "0.0.0.0", // reachable from everywhere
  port: 8080,
  ipWhitelist: [],
  language: 'de',
  modules: [
    // clock top left
    {
      module: "clock",
      position: "top_left",
      config: {
        timeFormat: 24, /* 24h */
        dateFormat: `dddd, ${"LL"}`,
      },
    },
    { module: "compliments", position: "lower_third" },
    {
      module: "MMM-Example",
      position: "top_right",
      config: {
        filter: /a\/b[/]c/gi,
        format: function (x) { return x / 2; }, // a function
        url: "https://example.com/{a}?b=${'c'}",
        apiKey: "${SECRET_KEY}",
        list: [1, 2, 3],
        nested: { a: { b: [ { c: "}" } ] } },
      }
    },
    {
      module: "newsfeed",
      position: "bottom_bar",
      header: 'News'
    }
  ]
};

/*************** DO NOT EDIT THE LINE BELOW ***************/
if (typeof module !== "undefined") { module.exports = config; }
