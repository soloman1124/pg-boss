const assert = require('assert');
const EventEmitter = require('events');

const Worker = require('./worker');
const plans = require('./plans');
const Attorney = require('./attorney');

const completedJobSuffix = plans.completedJobSuffix;

const events = {
  error: 'error'
};

class Manager extends EventEmitter {
  constructor(db, config){
    super();

    this.config = config;
    this.db = db;

    this.events = events;
    this.subscriptions = {};

    this.nextJobCommand = plans.fetchNextJob(config.schema);
    this.insertJobCommand = plans.insertJob(config.schema);
    this.completeJobsCommand = plans.completeJobs(config.schema);
    this.cancelJobsCommand = plans.cancelJobs(config.schema);
    this.failJobsCommand = plans.failJobs(config.schema);

    // exported api to index
    this.functions = [
      this.fetch,
      this.complete,
      this.cancel,
      this.fail,
      this.publish,
      this.subscribe,
      this.unsubscribe,
      this.onComplete,
      this.offComplete,
      this.fetchCompleted
    ];
  }

  stop() {
    Object.keys(this.subscriptions).forEach(name => this.unsubscribe(name));
    this.subscriptions = {};
    return Promise.resolve(true);
  }

  subscribe(name, ...args){
    return Attorney.checkSubscribeArgs(name, args)
      .then(({options, callback}) => this.watch(name, options, callback));
  }

  onComplete(name, ...args) {
    return Attorney.checkSubscribeArgs(name, args)
      .then(({options, callback}) => this.watch(name + completedJobSuffix, options, callback));
  }

  watch(name, options, callback){
    assert(!(name in this.subscriptions), 'this job has already been subscribed on this instance.');

    options.batchSize = options.batchSize || options.teamSize;

    if('newJobCheckInterval' in options || 'newJobCheckIntervalSeconds' in options)
      options = Attorney.applyNewJobCheckInterval(options);
    else
      options.newJobCheckInterval = this.config.newJobCheckInterval;

    let subscription = this.subscriptions[name] = {worker:null};

    let onError = error => this.emit(events.error, error);

    //  TODO: should respond return a promise to worker to defer polling
    let respond = jobs => {
      if (!jobs) return;

      if (!Array.isArray(jobs))
        jobs = [jobs];

      setImmediate(() => {
        // TODO: if batchSize option is passed, just respond with entire array
        // TODO: if teamSize option is passed, continue with current behavior
        jobs.forEach(job => {

          job.done = (error, response) => error ? this.fail(job.id, error) : this.complete(job.id, response);

          try {
            // TODO: detect promise here and to defer respond?
            callback(job);
          }
          catch (error) {
            // TODO: what to do here?
          }
        });
      });

    };

    let fetch = () => this.fetch(name, options.batchSize);

    let workerConfig = {
      name,
      fetch,
      respond,
      onError,
      interval: options.newJobCheckInterval
    };

    let worker = new Worker(workerConfig);
    worker.start();
    subscription.worker = worker;

    return Promise.resolve(true);
  }

  unsubscribe(name){
    if(!this.subscriptions[name]) return Promise.reject(`No subscriptions for ${name} were found.`);

    this.subscriptions[name].worker.stop();
    delete this.subscriptions[name];

    return Promise.resolve(true);
  }

  offComplete(name){
    return this.unsubscribe(name + completedJobSuffix);
  }

  publish(...args){
    return Attorney.checkPublishArgs(args)
      .then(({name, data, options}) => this.createJob(name, data, options));
  }

  publishThrottled(...args) {

  }

  publishDebounced(...args) {

  }

  createJob(name, data, options, singletonOffset){
    let startIn =
      (options.startIn > 0) ? '' + options.startIn
        : (typeof options.startIn === 'string') ? options.startIn
        : '0';

    let singletonSeconds =
      (options.singletonSeconds > 0) ? options.singletonSeconds
        : (options.singletonMinutes > 0) ? options.singletonMinutes * 60
        : (options.singletonHours > 0) ? options.singletonHours * 60 * 60
          : (options.singletonDays > 0) ? options.singletonDays * 60 * 60 * 24
            : null;

    let id = require(`uuid/${this.config.uuid}`)(),
      retryLimit = options.retryLimit || 0,
      expireIn = options.expireIn || '15 minutes',
      priority = options.priority || 0;

    let singletonKey = options.singletonKey || null;

    singletonOffset = singletonOffset || 0;

    let values = [id, name, priority, retryLimit, startIn, expireIn, data, singletonKey, singletonSeconds, singletonOffset];

    return this.db.executeSql(this.insertJobCommand, values)
      .then(result => {
        if(result.rowCount === 1)
          return id;

        if(!options.singletonNextSlot)
          return null;

        // delay starting by the offset to honor throttling config
        options.startIn = singletonSeconds;
        // toggle off next slot config for round 2
        options.singletonNextSlot = false;

        let singletonOffset = singletonSeconds;

        return this.createJob(name, data, options, singletonOffset);
      });
  }

  fetch(name, batchSize) {
    const names = Array.isArray(name) ? name : [name];

    return Attorney.checkFetchArgs(names, batchSize)
      .then(() => this.db.executeSql(this.nextJobCommand, [names, batchSize || 1]))
      .then(result => result.rows.length === 0 ? null :
                      result.rows.length === 1 && !batchSize ? result.rows[0] :
                      result.rows);
  }

  fetchCompleted(name, batchSize){
    return this.fetch(name + completedJobSuffix, batchSize);
  }

  mapCompletionIdArg(id, funcName) {
    const errorMessage = `${funcName}() requires an id`;

    return Attorney.assertAsync(id, errorMessage)
      .then(() => {
        let ids = Array.isArray(id) ? id : [id];
        assert(ids.length, errorMessage);
        return ids;
      });
  }

  mapCompletionDataArg(data) {
    if(data === null || typeof data === 'undefined' || typeof data === 'function')
      return null;

    return (typeof data === 'object' && !Array.isArray(data))
      ? data
      : { value:data };
  }

  mapCompletionResponse(ids, result) {
    return {
      jobs: ids,
      requested: ids.length,
      updated: result.rowCount
    };
  }

  complete(id, data){
    return this.mapCompletionIdArg(id, 'complete')
      .then(ids => this.db.executeSql(this.completeJobsCommand, [ids, this.mapCompletionDataArg(data)])
                    .then(result => this.mapCompletionResponse(ids, result))
      );
  }

  fail(id, data){
    return this.mapCompletionIdArg(id, 'fail')
      .then(ids => this.db.executeSql(this.failJobsCommand, [ids, this.mapCompletionDataArg(data)])
        .then(result => this.mapCompletionResponse(ids, result))
      );
  }

  cancel(id) {
    return this.mapCompletionIdArg(id, 'cancel')
      .then(ids => this.db.executeSql(this.cancelJobsCommand, [ids])
        .then(result => this.mapCompletionResponse(ids, result))
      );
  }

}

module.exports = Manager;
