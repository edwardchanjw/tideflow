import { Template } from 'meteor/templating'
import { servicesAvailable } from '/imports/services/_root/client'

Template['services.new'].helpers({
  servicesAvailable: servicesAvailable.filter(sa => sa.ownable)
})