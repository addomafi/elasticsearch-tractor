let es = require('elasticsearch')
let grok = require('node-grok')
let _ = require('lodash');
let extend = require('extend');
let AWS = require('aws-sdk');
let s3 = new AWS.S3();
let kinesis = new AWS.Kinesis();
let firehose = new AWS.Firehose();
let OnigRegExp = require('oniguruma').OnigRegExp;
let md5 = require('md5');
let moment = require('moment');
var LineStream = require('byline').LineStream;
var stream = require('stream');
const zlib = require('zlib');
var PromiseBB = require("bluebird");
// var heapdump = require('heapdump');

var elastictractor = function () {
	var self = this

	var template = function(tpl, args) {
		var value = {v: args, require: require}
		var keys = Object.keys(value),
				fn = new Function(...keys,
					'return `' + tpl.replace(/`/g, '\\`') + '`');
		return fn(...keys.map(x => value[x]));
	};

	self.client = new es.Client({
		host: process.env.ELK_HOST,
		log: 'warning'
	});

	self.matches = function (regex, value) {
		var onReg = new OnigRegExp(regex);
		var ret = onReg.testSync(value);
		onReg = null;
		return ret;
	};

	self._init = function() {
		return new Promise((resolve, reject) => {
			if (!self.config || process.hrtime(self.config.loadTime)[0] > 60) {
				self.client.search({
    			index: ".tractor",
    			body: {
            "size": 1000
          }
    		}).then(function(body) {
          var details = [];
					if (body && body.hits && body.hits.hits.length > 0) {
						var extractPatterns = _.filter(body.hits.hits, {"_type": "extractor_patterns_v2"})

						var patterns = [];
						// Create an array of patterns to extract info
						_.each(extractPatterns, item => {
							try {
								patterns.push(extend({
								}, JSON.parse(item["_source"].patternJSON)))
							} catch (err) {
								console.log(`Error to parse a JSON pattern "${item["_source"].patternJSON}"`)
							}
						})

						self.config = {
							loadTime: process.hrtime(),
							patterns: patterns
						};

						grok.loadDefault(function (err, patterns) {
							if (err) reject(err);
							else {
								self.config.grokPatterns = patterns
								// Load custom Grok patterns
								var customGrokPatterns = _.sortBy(_.filter(body.hits.hits, {"_type": "patterns"}), [function(o) { return o["_source"].priority; }])
								_.each(customGrokPatterns, item => {
									if (!self.config.grokPatterns.getPattern(item["_source"].id)) {
										self.config.grokPatterns.createPattern(item["_source"].pattern, item["_source"].id)
									}
								})
								console.log("Loaded");
								resolve(self.config);
							}
						});
					} else {
						reject("Extractor patterns wasn't defined, please define it firstly.");
					}
        }, function (error) {
					console.log(error);
          reject(error.message);
        });
			} else {
				resolve(self.config);
			}
		});
	}

	self._getDocumentToReindex = function (index, options) {
		return new Promise((resolve, reject) => {
			var currentMaxTimestamp = options.minTimestamp + (60000 * 60);
			console.log(`Processing ${index} minTimestamp ${options.minTimestamp} maxTimestamp ${currentMaxTimestamp}`);
			self.client.search({
				index: index,
				body: {
					"query": {
						"bool": {
							"must": [{
								"range": {
									"timestamp": {
										"gte": options.minTimestamp,
										"lte": currentMaxTimestamp,
										"format": "epoch_millis"
									}
								}
							},{
								"query_string": {
									"query": "errorMessage: /error/"
								}
							}]
						}
					},
					"size": 50
				}
			}, function (error, response) {
				if (error) {
					reject(error)
				}

				if (response && response.hits && response.hits.hits.length > 0) {
					resolve(response.hits.hits)
					response = null;
				} else {
					options.minTimestamp = currentMaxTimestamp;
					console.log("Without items to be processed!");
					reject("Without items to be processed!");
					response = null;
				}
			})
		})
	};

	self._getDocumentById = function (index, documentId) {
		return new Promise((resolve, reject) => {
			self.client.search({
				index: index,
				body: {
					"query": {
						"bool": {
							"must": [{
								"query_string": {
									"query": `_id:"${documentId}"`
								}
							}]
						}
					}
				}
			}, function (error, response) {
				if (error) {
          reject(error)
        }

				if (response && response.hits && response.hits.hits.length > 0) {
        	resolve(response.hits.hits[0]);
					response = null;
				} else {
					reject("Document not found")
					response = null;
				}
			})
    })
	};

	self._parseRegex = function(regex, data, timestamp) {
		return new Promise((resolve, reject) => {
			var pattern = self.config.grokPatterns.getPattern(md5(regex));
			if (!pattern) pattern = self.config.grokPatterns.createPattern(regex, md5(regex));
			pattern.parse(data, function (err, obj) {
					if (err) {
						console.log(err);
					}
					// Replace timestamp if data has one
					if (obj && timestamp) {
						obj.timestamp = timestamp
					}
					resolve(obj);
			});
		});
	}

	/**
	 * Process the regular expression to extract details
	 *
	 * @param  {[type]} data    Document to extract details
	 * @param  {[type]} pattern Pattern to extract details
	 * @return {[type]}         Promisse
	 */
	self._parse = function(data, pattern) {
		return new Promise((resolve, reject) => {
			// Array of promisse in execution
			var regexInProcessing = [];
			Object.keys(pattern.regexp).forEach( key => {
				pattern.regexp[key].map(function(regex) {
					regexInProcessing.push(self._parseRegex(regex, data[key], data.timestamp ? moment(data.timestamp).format('x') : undefined));
				})
			});
			// Wait for all promisses be finished
			Promise.all(regexInProcessing).then(results => {
				// Got only valid results
				var filtered = _.filter(results, x => x);

				var additionalExtractor = [];
				// Keep only data that satisfied all regexp
				if (filtered.length <  Object.keys(pattern.regexp).length) {
					filtered = []
				} else {
					var newItem = {}
					filtered.forEach(item => {
						extend(newItem, item)
					});

					filtered = [newItem]

					// Do some extra actions if need
					if (filtered.length && pattern.config.actions) {
						var onSuccess = pattern.config.actions.onSuccess;
						// Add info if necessary
						if (onSuccess) {
							if (onSuccess.parseJson) {
								onSuccess.parseJson.map(key => {
									try {
										extend(filtered[0], JSON.parse(filtered[0][key]))
									} catch(e) {
										// console.log(e)
									}

									delete filtered[0][key]
								})
							}
							if (onSuccess.add) {
								Object.keys(onSuccess.add).map(key => {
									filtered[0][key] = template(onSuccess.add[key], filtered[0])
									if (key === "timestamp") {
										data.timestamp = filtered[0][key]
									}
								})
							}
							if (onSuccess.delete) {
								onSuccess.delete.map(key => {
									delete filtered[0][key]
								})
							}
							if (onSuccess.parseInt) {
								onSuccess.parseInt.map(key => {
									filtered[0][key] = parseInt(filtered[0][key])
								})
							}
							if (onSuccess.extract) {
								onSuccess.extract.map(item => {
									Object.keys(item).map(key => {
										item[key].map(regexItem => {
											try {
												var value = template(`\$\{v.${key}\}`, filtered[0]);
												if (value !== "undefined") {
													additionalExtractor.push({
														"data": value,
														"regex": regexItem
													});
												}
											} catch (e) {}
										})
									})
								})
							}
						}
					}
				}

				var parsedObj = {results: filtered};

				// Check output type
				if (pattern.config.output) {
					parsedObj.output = [];
					pattern.config.output.forEach(item => {
						if (item.type === "aws:firehose" || item.type === "aws:kinesis") {
							parsedObj.output.push(item)
						} else if (item.type === "elasticsearch") {
							// Define index name
							var index;
							if (filtered.length && filtered[0].hasError) {
								index = `${item.prefix}error-${moment(data.timestamp, 'x').format('YYYY.MM.DD')}`
							} else {
								index = `${item.prefix}${moment(data.timestamp, 'x').format('YYYY.MM.DD')}`
							}
							parsedObj.output.push({index: index, type: item.type, id: data["_id"], url: item.url})
						}
					})
				}

				// Apply additional extractor if has one
				if (additionalExtractor.length) {
					regexInProcessing = [];
					additionalExtractor.map(item => {
						regexInProcessing.push(self._parseRegex(item.regex, item.data));
					})
					// Wait for all promisses be finished
					Promise.all(regexInProcessing).then(results => {
						// Got only valid results
						var filtered = _.filter(results, x => x);

						filtered.forEach(item => {
							extend(parsedObj.results[0], item)
						});
						resolve(parsedObj)
					}).catch(err => {
						reject(err)
					})
				} else {
					resolve(parsedObj)
				}
			}).catch(err => {
				reject(err);
			});
		})
	};

	self._processESDocument = function(config, data) {
		return new Promise((resolve, reject) => {
			if (!self.config) self.config = config;
			var patterns = _.filter(config.patterns, x => x.config.field && self.matches(x.config.field.regex, data["_source"][config.field.name]));
			if (patterns.length > 0) {
				patterns = patterns[0].regex
			} else {
				patterns = _.filter(config.patterns, x => _.indexOf(x.config.source, "OTHERS") > -1)[0].regex;
			}

			var all = _.filter(config.patterns, x => _.indexOf(x.config.source, "ALL") > -1)[0].regex;
			Object.keys(all).forEach(key => {
				if (patterns[key]) {
					patterns[key] = all[key].concat(patterns[key])
				} else {
					patterns[key] = all[key]
				}
			})

			var parsing = [];
			Object.keys(patterns).forEach(item => {
				parsing.push(self._parse(data, { patterns: patterns[item], fieldName: item}));
			});

			Promise.all(parsing).then(results => {
				results = results.reduce(function(a, b) {
					return a.concat(b);
				}, []);
				if (results.length > 0) {
					results = results.reduceRight(function(a, b) {
						return extend({}, a, b);
					});
				}
				if (results.length == 0 || !results.errorMessage) {
					results = {
						errorMessage: "N/A"
					};
				}
				resolve({index: data["_index"], type: data["_type"], id: data["_id"], results: results});
				parsing = null;
				all = null;
				patterns = null;
			}).catch(err => {
				reject(err);
				parsing = null;
				all = null;
				patterns = null;
			});
		});
	};

	self._getTimestamp = function (index, order) {
		return new Promise((resolve, reject) => {
			self.client.search({
				index: index,
				body: {
					"size": 1,
					"query": {
						"bool": {
							"must": [{
								"query_string": {
									"query": "errorMessage: /error/"
								}
							}]
						}
					},
					"_source": [ "timestamp" ],
					"sort": [
						{
							"timestamp": {
								"order": order
							}
						}
					]
				}
			}).then(function(data) {
				resolve(data);
			}, function(err) {
				reject(err);
			});
		});
	};

	self._processESDocumentBacklog = function(index, options) {
		return new Promise((resolve, reject) => {
			self._getDocumentToReindex(index, options).then(docs => {
				self._init().then(config => {
					var docsReindexing = [];
					Object.keys(docs).forEach(i => {
						docsReindexing.push(self._processESDocument(config, docs[i]));
					});

					Promise.all(docsReindexing).then(results => {
						results = results.reduce(function(a, b) {
							return a.concat(b);
						}, []);

						var body = [];
						results.forEach(function(item) {
							body.push({ update:  { _index: item.index, _type: item.type, _id: item.id } });
							body.push({ doc: item.results });
						});

						if (body.length > 0) {
							self.client.bulk({
								body: body
							}, function (error, response) {
								if (error) {
									console.log(error);
									reject(error);
								} else {
									resolve(response);
								}
							});
						}

					}).catch(err => {
						console.log(err);
						reject(err);
					});
				}).catch(err => {
					console.log(err);
					reject(err);
				});
			}).catch(err => {
				console.log(err);
				reject(err);
			});
		});
	};

	self._hasConfig = function(event, type) {
		var self = this
		return new Promise((resolve, reject) => {
			// Load configuration
			self._init().then(config => {
				// Keep only first pattern related the respective event _type
				var patterns = _.filter(config.patterns, x => x.config && _.indexOf(x.config.source, type) > -1 && x.config.field && self.matches(x.config.field.regex, template(x.config.field.name, event)))
				if (patterns.length > 0) {
					config.patterns = patterns;
					resolve(config);
				} else {
					reject("It's not configured.");
				}
			}).catch(err => {
				reject(err);
			})
		})
	}

	self._processEvent = function(event, config) {
		var self = this
		return new Promise((resolve, reject) => {
			var patternsInProcessing = []
			config.patterns.map(pattern => {
				patternsInProcessing.push(new Promise((resolve, reject) => {
					// Keep only elegible index
					pattern.config.output = _.filter(pattern.config.field.output, x => self.matches(x.regex, template(pattern.config.field.name, event)))

					var logs = event[pattern.config.field.data];
					delete event[pattern.config.field.data];
					PromiseBB.map(logs, function(data) {
						data.source = template(pattern.config.field.name, event);
						return self._parse(data, { config: pattern.config, regexp: pattern.regex });
					}, {concurrency: 100}).then(results => {
						// Keep only valid data
						results = _.filter(results, x => x.results.length)
						resolve(results);
						parsing = null;
					}).catch(err => {
						reject(err);
						parsing = null;
					});
				}))
			})

			Promise.all(patternsInProcessing).then(results => {
				// Concat all results
				results = results.reduce(function(a, b) {
					return a.concat(b);
				}, []);

				var output = {};
				results.forEach(result => {
					result.output.forEach(out => {
						if (out.type === "aws:kinesis") {
							// if array wasn't initialized
							if (!output.kinesis || !output.kinesis[out.arn]) {
								if (!output.kinesis) output.kinesis = {};
								output.kinesis[out.arn] = {
								   "StreamName": out.arn,
								   "Records": []
								};
							}
							output.kinesis[out.arn]["Records"].push({ "PartitionKey": "results", "Data": JSON.stringify(_.head(result.results)) });
						} else if (out.type === "aws:firehose") {
							// if array wasn't initialized
							if (!output.firehose || !output.firehose[out.arn]) {
								if (!output.firehose) output.firehose = {};
								output.firehose[out.arn] = {
								   "DeliveryStreamName": out.arn,
								   "Records": []
								};
							}
							output.firehose[out.arn]["Records"].push({ "Data": JSON.stringify(_.head(result.results)) });
						} else if (out.type === "elasticsearch") {
							// if array wasn't initialized
							if (!output.elk) output.elk = [];
							// Contructs the body object to foward to elasticsearch
							output.elk.push({ index:  { _index: out.index, _type: "metric" } });
							output.elk.push(_.head(result.results));
						}
					})
				});

				var processingOutput = []
				Object.keys(output).forEach(item => {
					if (item === "elk") {
						//  Send documents to elasticsearch, if has one
						if (output[item].length > 0) {
							// Split into chunk of 500 items
							var chunks = _.chunk(output[item], 500)
							processingOutput.push(PromiseBB.map(chunks, function(chunk) {
								return new Promise((resolve, reject) => {
									self.client.bulk({
										body: chunk
									}, function (error, response) {
										if (error) {
											console.log(error);
											reject(error);
										} else {
											resolve(response);
										}
									})
								})
							}, {concurrency: 1}));
						}
					} else if (item === "firehose" || item === "kinesis") {

						Object.keys(output[item]).forEach(stream => {
							processingOutput.push(new Promise((resolve, reject) => {
								var failureName = item === "firehose" ? "FailedPutCount" : "FailedRecordCount";

								var callback = function(err, data) {
									if (err) {
										console.log(err, err.stack);
										reject(err);
									} else {
										if (data[failureName] && data[failureName] > 0) {
											console.log(`Some records wasn't delivered, a total of ${data[failureName]}. ${JSON.stringify(data)}`)
										}
										console.log(`Was sent to ${item} ${output[item][stream]["Records"].length} records`)
										resolve(data);
									}
								};

								if (item === "firehose") {
									firehose.putRecordBatch(output[item][stream], callback);
								} else {
									kinesis.putRecords(output[item][stream], callback);
								}
							}))
						})
					}
				})

				Promise.all(processingOutput).then(results => {
					resolve(results);
				}).catch(err => {
					reject(err);
					parsing = null;
					all = null;
					patterns = null;
				})
			}).catch(err => {
				reject(err);
				parsing = null;
				all = null;
				patterns = null;
			});
		})
	};
}

elastictractor.prototype.reindexESDocument = function (index, documentId) {
	var self = this
	return new Promise((resolve, reject) => {
		self._getDocumentById(index, documentId).then(data => {
			self._init().then(config => {
				self._processESDocument(config, data).then(docReindexed => {
					// Update document
					self.client.update({
					  index: docReindexed.index,
					  type: docReindexed.type,
					  id: docReindexed.id,
						body: {
					    doc: docReindexed.results
					  }
					}, function (error, response) {
					  if (error)
							reject(error);
						else
							resolve(response);
					});
				}).catch(err => {
					reject(err);
				});
			}).catch(err => {
				reject(err);
			});
		}).catch(err => {
			reject(err);
		});
	})
};

/**
 * Process an event from CloudWatch logs, basically is extract metrics and error from these events
 *
 * @param  {[type]} awsLogEvent Event from CloudWatch logs
 * @return {[type]}             Promise
 */
elastictractor.prototype.processAwsLog = function(awsLogEvent) {
	var self = this
	return new Promise((resolve, reject) => {
		// Load configuration
		self._init().then(config => {
			// Keep only first pattern related to this CloudWatch logs
			var patterns = _.filter(config.patterns, x => x.config && _.indexOf(x.config.source, "aws:awsLogs") > -1 && x.config.field && self.matches(x.config.field.regex, awsLogEvent[x.config.field.name]))

			var patternsInProcessing = []
			patterns.map(pattern => {
				patternsInProcessing.push(new Promise((resolve, reject) => {
					// Keep only elegible index
					pattern.config.output = _.filter(pattern.config.field.output, x => self.matches(x.regex, awsLogEvent[x.name]))

					var logs = awsLogEvent.logEvents
					var parsing = [];
					logs.forEach(data => {
						data.source = awsLogEvent.logGroup
						parsing.push(self._parse(data, { config: pattern.config, regexp: pattern.regex}));
					})
					// Get results after pattern was applied
					Promise.all(parsing).then(results => {
						// Keep only valid data
						results = _.filter(results, x => x.results.length)
						resolve(results);
						parsing = null;
						all = null;
						patterns = null;
					}).catch(err => {
						reject(err);
						parsing = null;
						all = null;
						patterns = null;
					});
				}))
			})

			Promise.all(patternsInProcessing).then(results => {
				// Concat all results
				results = results.reduce(function(a, b) {
					return a.concat(b);
				}, []);

				var output = {};
				results.forEach(result => {
					result.output.forEach(out => {
						if (out.type === "aws:kinesis") {
							// if array wasn't initialized
							if (!output.kinesis || !output.kinesis[out.arn]) {
								if (!output.kinesis) output.kinesis = {};
								output.kinesis[out.arn] = {
								   "StreamName": out.arn,
								   "Records": []
								};
							}
							output.kinesis[out.arn]["Records"].push({ "PartitionKey": "results", "Data": JSON.stringify(_.head(result.results)) });
						} else if (out.type === "aws:firehose") {
							// if array wasn't initialized
							if (!output.firehose || !output.firehose[out.arn]) {
								if (!output.firehose) output.firehose = {};
								output.firehose[out.arn] = {
								   "DeliveryStreamName": out.arn,
								   "Records": []
								};
							}
							output.firehose[out.arn]["Records"].push({ "Data": JSON.stringify(_.head(result.results)) });
						} else if (out.type === "elasticsearch") {
							// if array wasn't initialized
							if (!output.elk) output.elk = [];
							// Contructs the body object to foward to elasticsearch
							output.elk.push({ index:  { _index: out.index, _type: "metric" } });
							output.elk.push(_.head(result.results));
						}
					})
				});

				var processingOutput = []
				Object.keys(output).forEach(item => {
					if (item === "elk") {
						//  Send documents to elasticsearch, if has one
						if (output[item].length > 0) {
							processingOutput.push(new Promise((resolve, reject) => {
								self.client.bulk({
									body: output.elk
								}, function (error, response) {
									if (error) {
										console.log(error);
										reject(error);
									} else {
										resolve(response);
									}
								});
							}))
						}
					} else if (item === "firehose" || item === "kinesis") {

						Object.keys(output[item]).forEach(stream => {
							processingOutput.push(new Promise((resolve, reject) => {
								var failureName = item === "firehose" ? "FailedPutCount" : "FailedRecordCount";

								var callback = function(err, data) {
									if (err) {
										console.log(err, err.stack);
										reject(err);
									} else {
										if (data[failureName] && data[failureName] > 0) {
											console.log(`Some records wasn't delivered, a total of ${data[failureName]}. ${JSON.stringify(data)}`)
										}
										console.log(`Was sent to ${item} ${output[item][stream]["Records"].length} records`)
										resolve(data);
									}
								};

								if (item === "firehose") {
									firehose.putRecordBatch(output[item][stream], callback);
								} else {
									kinesis.putRecords(output[item][stream], callback);
								}
							}))
						})
					}
				})

				Promise.all(processingOutput).then(results => {
					resolve(results);
				}).catch(err => {
					reject(err);
					parsing = null;
					all = null;
					patterns = null;
				})
			}).catch(err => {
				reject(err);
				parsing = null;
				all = null;
				patterns = null;
			});
		}).catch(err => {
			reject(err);
		});
	})
};


elastictractor.prototype.processS3 = function(s3Event) {
	var self = this
	return new Promise((resolve, reject) => {
		self._hasConfig(s3Event, "aws:s3").then(config => {
			var s3Stream = s3.getObject({Bucket: s3Event.s3.bucket.name, Key: decodeURIComponent(s3Event.s3.object.key.replace(/\+/g, ' '))}).createReadStream();
			var lineStream = new LineStream();
			var logs = []
	    s3Stream
			  .pipe(zlib.createGunzip())
	      .pipe(lineStream)
				// .pipe(recordStream)
	      .on('data', function(data) {
					logs.push({
						message: data.toString(),
						source: `${s3Event.s3.bucket.name}-${s3Event.s3.object.key}`
					})
	      }).on('end', function() {
					if (logs.length > 0) {
						var events = [];
						var chunks = _.chunk(logs, 5000)
						chunks.map(chunk => {
							events.push(extend({logs: chunk}}, s3Event));
						});
						logs = [];
						PromiseBB.map(events, function(event) {
							return self._processEvent(event, config)
						}, {concurrency: 1}).then(response => {
							resolve(response);
						}).catch(err => {
							reject(err);
						});
					} else {
						reject("No log to be processed!");
					}
	      });
		}).catch(err => {
			reject(err)
		})
	});
};

elastictractor.prototype.processSNS = function(snsEvent) {
	var self = this
	return new Promise((resolve, reject) => {
		tractor.reindexESDocument(component.Sns.Subject, component.Sns.Message).then(response => {
			resolve(response);
		}).catch(err => {
			reject(err);
		});
	});
};

/*
* Process any elasticsearch document that contains a text "error" on the field errorMessage.
*/
elastictractor.prototype.processESBacklog = function (index) {
	var self = this
	return new Promise((resolve, reject) => {
		var minTimestamp = 0;
		var maxTimestamp = 0;

		self._getTimestamp(index, 'asc').then(min => {
			if (min.hits.hits[0]) {
				minTimestamp = min.hits.hits[0].sort[0];
				self._getTimestamp(index, 'desc').then(max => {
					maxTimestamp = max.hits.hits[0].sort[0];
					var options = {
						minTimestamp: minTimestamp,
						maxTimestamp: maxTimestamp
					};
					var overloadCall = function(index, options) {
						self._processESDocumentBacklog(index, options).then(results => {
							if (!(options.minTimestamp < options.maxTimestamp)) {
								console.log('Finish');
								resolve(results);
							} else {
								// heapdump.writeSnapshot(function(err, filename) {
								// 	console.log('dump written to', filename);
								// });
								overloadCall(index, options);
							}
						}).catch(err => {
							if (options.minTimestamp < options.maxTimestamp) {
								overloadCall(index, options);
							} else {
								console.log('Finish');
								resolve('Finish');
							}
						});
					};
					if (options.minTimestamp <= options.maxTimestamp) {
						overloadCall(index, options);
					}
				}).catch(err => {
					console.log(err);
					reject(err);
				});
			} else {
				reject("Document not found");
			}
		}).catch(err => {
			console.log(err);
			reject(err);
		});
	});
};

module.exports = elastictractor
